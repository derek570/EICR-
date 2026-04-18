# Phase 4a — Context

**Commit:** `b0eb64c`

## Commit message

```
commit b0eb64c1f1af456695b875825ff74e8cbe6cc6ee
Author:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
AuthorDate: Fri Apr 17 12:50:53 2026 +0100
Commit:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
CommitDate: Fri Apr 17 12:50:53 2026 +0100

    feat(web): Phase 4a recording overlay + transcript bar scaffold
    
    What
    - Add RecordingProvider at `web/src/lib/recording-context.tsx` exposing a
      state machine (idle → requesting-mic → active → dozing → sleeping /
      error), mic level (0-1), elapsed seconds, cost readout, rolling
      transcript buffer (last 10 utterances), and start/stop/pause/resume/
      minimise/expand actions.
    - Add `web/src/components/recording/recording-overlay.tsx` — full-sheet
      overlay with a brand-gradient hero (state pill + timer + cost),
      central mic visualiser with RMS-driven outer ring, transcript log
      (newest-first, fade on stale), and Pause/Resume/Stop controls.
    - Add `web/src/components/recording/transcript-bar.tsx` — top-docked
      sticky strip shown whenever a session is running but the overlay has
      been minimised. Mic icon pulses, elapsed timer + latest final
      utterance, tap to re-expand.
    - Wire RecordingProvider into `/job/[id]/layout.tsx`, mount the
      overlay + transcript bar alongside the existing floating action bar.
    - Replace the mic stub in `floating-action-bar.tsx`: tapping now calls
      `useRecording().start()` (or re-expands a minimised session). Button
      flips to red + pulse while a session is live, matching iOS.
    
    Why
    - The recording pipeline is the feature that delivers the whole
      product — inspectors dictate test readings and observations, and
      Sonnet 4.5 extracts structured fields in real time. The rebuild
      mandate is iOS pixel parity, and the iOS RecordingOverlay is one
      of the most visible surfaces.
    - Phasing 4 into sub-phases (4a scaffold → 4b AudioWorklet → 4c
      Deepgram WS → 4d Sonnet WS → 4e VAD sleep/wake) lets each increment
      commit + visually verify without pending on a microphone permission
      or WebSocket dependency.
    
    Why this approach
    - Provider-based context (not a global store / zustand) because the
      recording state is scoped to a single job surface — unmounting the
      job layout tears down the session naturally.
    - Scaffold uses a deterministic synth loop (rota of realistic
      inspector phrases every 2.2s, mic level as two summed sines) so
      visual verification runs without a mic prompt and so iOS parity
      screenshots can be diffed straight away.
    - State machine names (`dozing` / `sleeping`) mirror the iOS
      `SleepManager` states so Phase 4e can wire real VAD transitions in
      without renaming anything.
    - Overlay is a bottom-sheet on mobile and centred card on desktop —
      matches iOS UX and avoids full-screen modal on large displays
      where the user likely has the job detail open side-by-side.
    - Transcript bar is a separate component so it can stay visible when
      the overlay is minimised (the iOS pattern) without forcing the
      overlay to render at all times.
    
    Context
    - This is Phase 4a of the web-rebuild ground-up effort. No real audio
      work is landed here — `start()` stubs the getUserMedia call with a
      250ms delay so the requesting-mic state has a visible duration.
      Phase 4b will replace the synth loop with AudioWorklet + 16kHz
      PCM16 resampler + ring buffer; Phase 4c connects Deepgram Nova-3
      directly from the browser; Phase 4d wires the backend Sonnet
      WebSocket and propagates extracted fields back to JobContext.
```

## Files changed

```
 web/src/app/job/[id]/layout.tsx                    |  19 +-
 web/src/components/job/floating-action-bar.tsx     |  34 ++-
 web/src/components/recording/recording-overlay.tsx | 269 +++++++++++++++++++++
 web/src/components/recording/transcript-bar.tsx    |  57 +++++
 web/src/lib/recording-context.tsx                  | 246 +++++++++++++++++++
 5 files changed, 613 insertions(+), 12 deletions(-)
```
