## 1. Summary of the phase

Phase 4a adds a job-scoped `RecordingProvider`, a full recording overlay, a minimised transcript bar, and wires the mic button in the floating action bar to start or reopen a recording session. The implementation is clearly intended as a visual scaffold: it simulates a short “requesting mic” state, drives a synthetic mic level, and emits fake transcript phrases for UI verification without real audio or websocket dependencies.

The working tree has moved on substantially since `b0eb64c` (`72fb7da`/`9e93907`/`b6c4b65`/`9f1dba6` replace most of this scaffold), so the findings below are about the commit itself unless noted otherwise.

## 2. Alignment with original plan

Broadly, the commit matches the handoff doc and commit intent:

- `RecordingProvider` was added and mounted in `web/src/app/job/[id]/layout.tsx:73-83` (commit `b0eb64c`).
- The overlay scaffold matches the intended surface and controls in `web/src/components/recording/recording-overlay.tsx:22-175`.
- The transcript bar exists and is shown only while a session is minimised in `web/src/components/recording/transcript-bar.tsx:17-56`.
- The mic button was rewired in `web/src/components/job/floating-action-bar.tsx:35-45,144-166`.

Missing / not fully aligned with the stated plan:

- The advertised state machine is only partially implemented. `sleeping` and `error` exist in types/UI labels, but no code path in Phase 4a transitions into either state or surfaces a real error (`web/src/lib/recording-context.tsx:33-71,147-181`).
- The context comment says `start()` synthesises “partial/final transcripts every ~1.5s”, but the implementation emits only final utterances every 2.2s (`web/src/lib/recording-context.tsx:27-30,126-145`).
- The commit message mentions “rolling transcript buffer (last 10 utterances)” and that is implemented, but there is no distinct partial/interim scaffold despite the surrounding comments implying one.

## 3. Correctness issues

- **P1** `start()` is race-prone and can resurrect a session after the user has already stopped it. `start()` awaits 250ms, then unconditionally sets `active` and starts the synth timers, with no cancellation check (`web/src/lib/recording-context.tsx:147-160`). If the user taps stop during the delay, or the provider unmounts, the pending async continuation still runs.
- **P1** `start()` can create duplicate synth loops under rapid repeated clicks. The guard uses captured React state (`if (state !== 'idle' && state !== 'error') return`), so two clicks before the next render can both pass the guard and both call `beginSynthLoop()` after the delay (`web/src/lib/recording-context.tsx:147-160`). That would double-count elapsed time/cost and duplicate transcript emission.
- **P2** The phase claims `error` is surfaced for permission denial / websocket drop, but Phase 4a has no path that ever sets `state` to `error` or populates error handling beyond a string slot (`web/src/lib/recording-context.tsx:25,54-55,147-181`). As committed, error semantics are dead.
- **P2** `sleeping` is exposed in the public state and UI, but is unreachable in the provider (`web/src/lib/recording-context.tsx:33-71,171-181`; `web/src/components/recording/recording-overlay.tsx:41-44,187-190`). That is harmless for a scaffold, but it means the exported contract is ahead of reality.
- **P2** Pausing leaves the last mic level frozen instead of resetting to a paused/resting visual state. `pause()` clears timers and changes state but does not zero `micLevel` (`web/src/lib/recording-context.tsx:171-175`), so the ring scale can stay visibly “hot” while paused.

## 4. Security issues

No material security issues found in this commit.

- **Severity: none identified** No XSS, auth, CSRF, secret leakage, or injection risks are introduced by the overlay scaffold itself. The phase is UI-only and does not yet connect to microphone APIs or remote services.

## 5. Performance issues

- **P2** The entire recording context value is rebuilt on every 100ms tick (`web/src/lib/recording-context.tsx:186-217`), and consumers subscribe to the whole object via `useRecording()`. This forces `FloatingActionBar`, `TranscriptBar`, and `RecordingOverlay` to rerender on every `micLevel`/timer/cost update even when they only need a small subset of fields.
- **P2** `micLevel`, `elapsedSec`, and `costUsd` are all driven through React state at 10Hz (`web/src/lib/recording-context.tsx:114-145`). That is acceptable for the overlay itself, but there is no selector split or memo boundary to contain the rerender surface.

## 6. Accessibility issues

- **P1** The overlay is marked as a modal dialog but has no focus trap, no initial focus target, and no focus restoration (`web/src/components/recording/recording-overlay.tsx:53-61`). Keyboard users can tab behind the modal.
- **P2** The dialog does not support keyboard dismissal patterns such as `Escape`, despite offering close/minimise controls (`web/src/components/recording/recording-overlay.tsx:87-90,164-171`).
- **P2** The transcript area is not exposed as a live region, so newly arriving transcript entries are unlikely to be announced to assistive tech (`web/src/components/recording/recording-overlay.tsx:141-161`; `web/src/components/recording/transcript-bar.tsx:27-55`).
- **P2** The transcript bar’s only accessible name is “Expand recording overlay”; it does not expose the elapsed time or latest utterance semantically to assistive technology (`web/src/components/recording/transcript-bar.tsx:28-55`).

## 7. Code quality

- Comments and implementation drift in `web/src/lib/recording-context.tsx:27-30,126-145`: the docs describe partial/final transcript scaffolding at ~1.5s, but the code emits only finals at 2.2s.
- The public API exports states that Phase 4a does not actually implement (`sleeping`, `error`), which increases cognitive load for consumers (`web/src/lib/recording-context.tsx:33-71`).
- The “keep elapsed/transcript visible for ~400ms” comment in `stop()` does not match behavior; the overlay closes immediately and there is no exit animation code in this commit (`web/src/lib/recording-context.tsx:162-169`).

## 8. Test coverage gaps

There are no recording-related tests in the `web/` package at this point; `find web -maxdepth 3 \( -name '*test.*' -o -name '*spec.*' \)` returned no matches.

Missing coverage that would have caught the main risks:

- `start()` called twice quickly should produce only one active session/timer set.
- `stop()` during the 250ms “requesting mic” delay should not transition back to `active`.
- `pause()` / `resume()` should preserve elapsed time without duplicating timers.
- Overlay accessibility behavior: modal focus containment, close/minimise keyboard paths, and transcript announcement semantics.
- Transcript bar visibility rules: hidden in `idle`, shown only when session is active and overlay is minimised.

## 9. Suggested fixes

1. **`web/src/lib/recording-context.tsx:147-160`**  
   Add a session token / cancellation ref around `start()`. Increment it before awaiting, capture it locally, and bail after the `await` if the token is stale or the provider has unmounted.  
   Why: prevents `stop()`/unmount races from reactivating the session after the user has already closed it.

2. **`web/src/lib/recording-context.tsx:147-160`**  
   Add an in-flight guard independent of render timing, e.g. `pendingStartRef`, and clear any existing timers before starting a new synth loop.  
   Why: prevents double-clicks from launching overlapping `setInterval` loops and corrupting elapsed time/cost/transcript state.

3. **`web/src/lib/recording-context.tsx:171-175`**  
   Reset `micLevel` to `0` when pausing, and consider restoring a defined resting level on resume.  
   Why: avoids a paused overlay visually implying that speech/audio activity is still present.

4. **`web/src/lib/recording-context.tsx:33-71,147-181`**  
   Either implement explicit Phase 4a stub transitions for `error`/`sleeping`, or remove them from the exported contract and UI until the later phases land.  
   Why: the current public state machine overpromises behavior that does not exist.

5. **`web/src/components/recording/recording-overlay.tsx:53-61`**  
   Add proper modal behavior: focus the first control on open, trap focus within the overlay, restore focus to the mic button on close/minimise, and handle `Escape`.  
   Why: `role="dialog"` + `aria-modal="true"` is incomplete without keyboard focus management.

6. **`web/src/lib/recording-context.tsx:186-217` and consumers in `web/src/components/job/floating-action-bar.tsx:35-45`, `web/src/components/recording/transcript-bar.tsx:17-26`**  
   Split the recording context into smaller contexts or selector-style hooks so controls that only need `state`/`expand` do not rerender on every `micLevel` tick.  
   Why: reduces unnecessary rerenders as the real audio pipeline arrives in later phases.

7. **`web/src/lib/recording-context.tsx:27-30,126-145`**  
   Make the comments match the scaffold, or add a simple interim transcript stub if that was the original visual requirement.  
   Why: the current documentation misdescribes what the code actually does.

8. **`web/src/components/recording/recording-overlay.tsx:141-161` and `web/src/components/recording/transcript-bar.tsx:27-55`**  
   Expose transcript updates through an `aria-live` region and ensure the minimised bar exposes meaningful text, not just an action label.  
   Why: improves screen-reader usability for the primary output of the recording flow.

## 10. Overall verdict

**Needs rework**

The phase is directionally solid and matches the intended UI scaffold, but the async session lifecycle is not robust enough to ship even as a scaffold. The highest-priority fixes are:

1. Guard `start()` against stop/unmount/double-click races in `web/src/lib/recording-context.tsx:147-160`.
2. Add real modal accessibility behavior to `web/src/components/recording/recording-overlay.tsx:53-61`.
3. Either implement or remove the unimplemented `sleeping`/`error` state contract in `web/src/lib/recording-context.tsx:33-71,147-181`.