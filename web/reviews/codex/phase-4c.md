## 1. Summary of the phase

Phase 4c replaces the scaffolded transcript path with a direct browser-to-Deepgram Nova-3 WebSocket, fetching a short-lived token from the backend and streaming live mic PCM from the existing `AudioWorklet` pipeline. It also adds interim transcript UI in the overlay and minimised transcript bar, while appending final utterances into the rolling transcript log.

## 2. Alignment with original plan

The implementation matches most of the handoff/commit intent: it adds a dedicated `DeepgramService`, fetches a scoped token through `api.deepgramKey(sessionId)`, forwards live mic samples into Deepgram, and renders interim/final transcript text in the two recording surfaces.

Missing/misaligned items:
- `deepgramState` is added to context (`web/src/lib/recording-context.tsx:63-65,101,302` in commit `9e93907`) but is not actually surfaced in the Phase 4c UI, despite the comments saying it should be available “for debugability”.
- In the current working tree, docs have drifted: [web/README.md](/Users/derekbeckley/Developer/EICR_Automation/web/README.md:69) still documents `/api/proxy/deepgram-streaming-key`, while Phase 4c code uses `/api/deepgram-proxy`.

## 3. Correctness issues

- **P1** `web/src/lib/recording-context.tsx:159-194,198-219,221-251,275-289`  
  `start()`/`resume()` have no cancellation or generation guard around the async mic-open + token-fetch path. If the user taps `Stop`/`Pause` or the provider unmounts while `startMicCapture()` or `api.deepgramKey()` is in flight, the stale continuation can still assign `micRef`/`deepgramRef`, reopen the socket, and flip the session back to `active`. This is a real resurrected-session race.
- **P1** `web/src/lib/recording/deepgram-service.ts:82-95,271-274` and `web/src/lib/recording-context.tsx:183-190,233-236`  
  Deepgram transport failure does not transition the recording session into `error` or stop billing/timers. The provider only stores `errorMessage`; `state` remains `active`, the hero pill still says “Recording”, the mic stays open, and cost keeps increasing even though transcription is dead.
- **P1** `web/src/lib/recording-context.tsx:159-194,198-219` and `web/src/lib/recording/deepgram-service.ts:103-120`  
  Audio is captured before the token fetch and WebSocket handshake complete, and `sendSamples()` drops everything until `state === 'connected'`. Early speech right after start/resume is silently lost, so the first words of an utterance can disappear on slower networks.
- **P2** `web/src/lib/recording/deepgram-service.ts:124-148`  
  `disconnect()` schedules a delayed `setState('disconnected')` 300ms later. If a new `DeepgramService` instance is opened before that timeout fires, the old instance can still push `deepgramState` back to `disconnected`, producing stale UI state.

## 4. Security issues

- **P2** `web/src/lib/api-client.ts:144-147`  
  Temporary Deepgram credential minting is done via a cacheable `GET` query (`/api/deepgram-proxy?sessionId=...`). That makes a credential-bearing response easier to cache or log in intermediaries/browser caches unless the backend is perfectly configured. This should be a `POST` with `cache: 'no-store'` and strict `Cache-Control: no-store` server-side.

## 5. Performance issues

- `web/src/lib/recording-context.tsx:294-328`  
  The entire recording context value is rebuilt on every mic-level tick, elapsed-time tick, interim transcript update, and Deepgram state change. Phase 4c increases update frequency materially, so all `useRecording()` consumers rerender more often than necessary.
- `web/src/lib/recording/deepgram-service.ts:103-120,177-188`  
  Each audio block allocates fresh resample/output buffers on the main thread. The block size is small, so this is not catastrophic, but it does create steady GC churn in the hottest path.

## 6. Accessibility issues

- `web/src/components/recording/recording-overlay.tsx:143-173`  
  Live transcript updates are not exposed through an `aria-live` region, so screen-reader users do not get the core Phase 4c feature announced as it changes.
- `web/src/components/recording/transcript-bar.tsx:30-56`  
  The button’s accessible name is always “Expand recording overlay”; it does not include the current elapsed time or transcript/interim text, so the live status is largely invisible to assistive tech.

## 7. Code quality

- `web/src/lib/recording-context.tsx:63-65,101,302` and `web/src/components/recording/*`  
  `deepgramState` is wired through the provider but unused by the UI in this phase. That leaves dead public surface area and comments that overstate what shipped.
- Current working tree drift: [web/README.md](/Users/derekbeckley/Developer/EICR_Automation/web/README.md:69) documents a different backend contract than the code. That increases integration risk.

## 8. Test coverage gaps

No automated tests were found under `web/` for this phase.

Missing coverage is most acute for:
- Deepgram message parsing and final/interim routing in `deepgram-service.ts`
- `RecordingProvider` async lifecycle races (`start`/`stop`/`pause`/`resume`)
- start-of-session audio buffering/first-utterance behaviour
- overlay/transcript-bar rendering of interim vs final text
- Deepgram failure handling and session state transitions

## 9. Suggested fixes

1. **`web/src/lib/recording-context.tsx:159-194,221-289`**  
   Add a session-generation or cancellation ref and check it after every awaited step (`startMicCapture`, `api.deepgramKey`, WebSocket open). Ignore stale completions and avoid assigning refs/state if the session was stopped, paused, or superseded.  
   Why: prevents resurrected mic/WebSocket sessions after `stop()`/`pause()`.

2. **`web/src/lib/recording/deepgram-service.ts:82-95,271-274` and `web/src/lib/recording-context.tsx:183-190`**  
   Treat Deepgram socket/message failures as fatal for Phase 4c: set `state` to `error`, clear the tick, tear down mic + socket, and distinguish clean close from error close.  
   Why: the UI should not stay in “Recording” while transcription has already failed.

3. **`web/src/lib/recording-context.tsx:198-219` and `web/src/lib/recording/deepgram-service.ts:59-121`**  
   Either buffer outbound PCM until `ws.onopen` fires, or make `connect()` await readiness before `start()`/`resume()` mark the session active.  
   Why: avoids clipping the inspector’s first words on slower token fetch/WS handshakes.

4. **`web/src/lib/recording/deepgram-service.ts:124-148`**  
   Store the disconnect timeout id and clear/ignore it when a new connection supersedes the old instance, or guard `onStateChange` with an instance token.  
   Why: stale `disconnect()` callbacks should not overwrite the current session’s `deepgramState`.

5. **`web/src/lib/api-client.ts:144-147`**  
   Change Deepgram token minting to `POST`, add `cache: 'no-store'`, and ensure backend responses are marked `Cache-Control: no-store`.  
   Why: temporary credentials should not rely on cache hygiene around a `GET` endpoint.

6. **`web/src/components/recording/recording-overlay.tsx:143-173`**  
   Add a polite live region for transcript updates, ideally with separate handling for interim vs final text to avoid over-announcement.  
   Why: live transcription is otherwise inaccessible to screen-reader users.

7. **`web/src/components/recording/transcript-bar.tsx:30-56`**  
   Expose the current transcript/timer in the control’s accessible name or via `aria-describedby`.  
   Why: the minimised bar currently communicates almost none of its live state semantically.

8. **`web/src/lib/recording-context.tsx:294-328`**  
   Split hot recording fields into narrower contexts or adopt context selectors.  
   Why: live interim updates and 60Hz mic-level pushes currently rerender unrelated consumers.

9. **`web/src/components/recording/*` or `web/src/lib/recording-context.tsx:63-65`**  
   Either render `deepgramState` somewhere in the overlay as intended, or remove the debugability comments/public field until it is used.  
   Why: reduces contract drift.

## 10. Overall verdict

**Needs rework.**

Top 3 priority fixes:
1. Guard the async `start()`/`resume()` pipeline against stale completions.
2. Fail the recording session cleanly when Deepgram fails instead of staying `active`.
3. Stop dropping initial audio before the WebSocket is ready.

The current working tree has moved on substantially in `recording-context.tsx` and `deepgram-service.ts`, but the first two issues still appear to remain unresolved there.