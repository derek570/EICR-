## 1. Summary of the phase

Phase 4b replaces the Phase 4a synthetic recording loop with real microphone capture using `getUserMedia` plus an `AudioWorklet`/`ScriptProcessor` pipeline. It also feeds a live RMS-derived mic level into `RecordingProvider`, starts/stops elapsed time and notional Deepgram cost while streaming, and surfaces microphone errors into the existing recording UI.

## 2. Alignment with original plan

The implementation mostly matches the handoff and commit intent:

- `web/public/audio-worklet-processor.js` was added and posts `Float32Array` blocks back to the main thread.
- `web/src/lib/recording/mic-capture.ts` centralises mic setup, level calculation, and fallback logic as planned.
- `RecordingProvider.start()` / `resume()` now use real mic capture instead of the Phase 4a synth loop, and transcripts stay empty pending Phase 4c.

Minor misses vs. stated intent:

- The commit message says the overlay renders a `"Listening…"` placeholder while waiting; in practice the minimised transcript bar shows `"Listening…"`, but the overlay body shows `"Start speaking — transcripts will appear here in real time."` rather than the claimed placeholder.
- The “friendly permission denied” handling is only implemented in `start()`, not in `resume()`, so the behavior is inconsistent after a pause/resume cycle.

## 3. Correctness issues

### P1

- `web/src/lib/recording-context.tsx:132-170`, `172-178`
  `start()` is not cancellation-safe. If the user hits Stop while `startMicCapture()` is still awaiting `getUserMedia` / `AudioContext` setup, `stop()` sets the state back to `idle`, but the in-flight `start()` continues and can later set `micRef`, flip state to `active`, and restart ticking. This can reopen recording after the user explicitly cancelled.

- `web/src/lib/recording/mic-capture.ts:79-82`
  The AudioWorklet path connects `source -> workletNode` but never connects the worklet into a live downstream graph. Web Audio rendering is pull-based; a disconnected processor is not guaranteed to run. The fallback path explicitly connects to `audioContext.destination` to stay alive, but the preferred worklet path does not, so the “real mic capture” path is at risk of producing no callbacks in browsers that require a rendered graph.

### P2

- `web/src/lib/recording-context.tsx:191-216`
  `resume()` does not reuse the same permission-denied normalization as `start()`. If mic permission is revoked or re-prompted on resume, the user gets the raw browser error string instead of the friendly message promised by the phase.

- `web/src/lib/recording-context.tsx:148-153`, `201-206`
  The `onError` handlers mutate global provider state without checking that the failing capture handle is still the current one. Combined with the uncancelled async start/resume path, a stale capture instance can race and overwrite a newer session’s state.

- `web/src/lib/recording-context.tsx:134-139`, `148-153`
  Error recovery does not reset `micLevel`. After an error, the overlay can retain a stale ring scale from the previous audio level, which is misleading for an error/permission-denied state.

## 4. Security issues

No material Phase 4b security findings.

- `None [low]`: No new XSS, auth, CSRF, injection, secret leakage, or CORS issues were introduced in this phase from the code reviewed.

## 5. Performance issues

- `web/src/lib/recording-context.tsx:141-147`, `194-200`
  The 60 Hz throttling on `setMicLevel` is a good guard and avoids the obvious render flood from ~8 ms audio callbacks.

- `web/src/lib/recording/mic-capture.ts:83-88`
  The `ScriptProcessorNode` fallback uses a 4096-frame buffer, which is a large latency step for a VU meter and future streaming consumers. This is probably acceptable as a fallback, but it will feel visibly laggier than the worklet path.

No major render or memory regressions beyond the correctness issues above.

## 6. Accessibility issues

- `web/src/components/recording/recording-overlay.tsx:65-70`
  The overlay uses `role="dialog"` and `aria-modal="true"`, which is good, but there is still no visible focus management or initial focus target. That appears to predate 4b rather than being introduced here.

- Phase 4b itself did not introduce a clear new accessibility regression in the reviewed diff.

## 7. Code quality

- `web/src/lib/recording-context.tsx:141-153`, `194-206`
  The mic bootstrap and error-handling logic is duplicated between `start()` and `resume()`. That duplication already caused behavior drift: `start()` normalizes permission-denied errors, `resume()` does not.

- `web/src/lib/recording/mic-capture.ts:35-37`
  The `onSamples` comment says “the underlying buffer is reused by the caller,” but both paths allocate/copy fresh `Float32Array`s before invoking callbacks. The comment does not match the implementation.

## 8. Test coverage gaps

There appears to be no test coverage for this area; I did not find any `test`/`spec` files under `web/`.

Missing coverage that matters for this phase:

- `start()` cancellation while permission is pending.
- AudioWorklet path actually producing callbacks.
- ScriptProcessor fallback behavior.
- Permission-denied handling in both `start()` and `resume()`.
- Mic track ended / device unplugged error propagation.
- UI state after start, pause, resume, stop, and error transitions.

## 9. Suggested fixes

1. `web/src/lib/recording-context.tsx:132-170`
   Add request/session scoping to `start()`. Capture a local session token before awaiting `startMicCapture()`, and after each await confirm it is still the active request before mutating state or storing `micRef`.
   Why: prevents Stop/cancel races from resurrecting a session after the user has already ended it.

2. `web/src/lib/recording-context.tsx:191-216`
   Apply the same session-token / cancellation guard to `resume()`, and share the mic-open path with `start()` via a single helper.
   Why: fixes the same race on resume and removes duplicated logic that is already drifting.

3. `web/src/lib/recording/mic-capture.ts:79-82`
   Keep the worklet in a live graph, e.g. connect it to a muted `GainNode` (`gain.value = 0`) and then to `audioContext.destination`, or use a processor configuration that is explicitly valid as a sink.
   Why: ensures the preferred AudioWorklet path actually renders and emits `port.onmessage` callbacks across browsers.

4. `web/src/lib/recording-context.tsx:158-167`, `211-214`
   Extract error normalization into a shared helper and use it from both `start()` and `resume()`.
   Why: makes permission-denied behavior consistent with the phase intent.

5. `web/src/lib/recording-context.tsx:148-153`, `201-206`
   Bind `onError` to the specific `MicCaptureHandle` or session token that created it, and ignore callbacks from stale handles.
   Why: prevents old sessions from flipping the provider into `error` after a newer session has started.

6. `web/src/lib/recording-context.tsx:134-139`, `148-153`, `172-178`
   Reset `micLevel` to `0` on new start attempts and on error transitions.
   Why: avoids stale VU visuals in error and retry flows.

7. `web/src/lib/recording/mic-capture.ts:35-37`
   Update the `onSamples` doc comment to reflect the actual ownership/copy semantics.
   Why: the current comment is misleading for future Phase 4c/4e consumers.

## 10. Overall verdict

**Ship with fixes**

The phase is close to the stated intent and the structure is sound, but there are two important correctness risks in the core recording path: the uncancelled async start/resume flow and the incomplete AudioWorklet graph. Those are both central to “real mic capture,” so I would fix them before treating Phase 4b as reliable.

Top 3 priority fixes:

1. Make `start()` / `resume()` cancellation-safe so Stop cannot be undone by an in-flight mic request.
2. Keep the AudioWorklet connected to a live graph so the preferred capture path actually runs.
3. Deduplicate mic startup/error handling and normalize permission-denied behavior consistently in both `start()` and `resume()`.

Line numbers above refer to the `72fb7da` snapshot from `git show`; the working tree has since evolved into later phases, but these findings were reviewed against the Phase 4b commit itself.