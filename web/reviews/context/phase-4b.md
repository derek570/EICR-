# Phase 4b — Context

**Commit:** `72fb7da`

## Commit message

```
commit 72fb7dac47cf26e28a8da9c57df3d843f7d0a4e9
Author:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
AuthorDate: Fri Apr 17 12:54:23 2026 +0100
Commit:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
CommitDate: Fri Apr 17 12:54:23 2026 +0100

    feat(web): Phase 4b real mic capture via AudioWorklet + RMS VU meter
    
    What
    - Add `web/public/audio-worklet-processor.js` — 128-sample PCM capture
      processor that posts Float32Array blocks to the main thread with a
      transferable buffer (zero-copy).
    - Add `web/src/lib/recording/mic-capture.ts` — `startMicCapture({
      onSamples, onLevel, onError })` helper that opens the mic at 16kHz
      mono, wires the AudioWorklet (with ScriptProcessor fallback for
      older browsers / corporate VPN blockers), computes RMS per block,
      and emits a smoothed 0-1 level to the caller.
    - Refactor `RecordingProvider.start()` / `resume()` to use real
      `startMicCapture()` instead of the Phase 4a synth loop. Mic level
      now reacts to actual speech; the cost ticker runs at Deepgram's
      $0.0077/min rate while audio is streaming.
    - `start()` now surfaces a friendly error when permission is denied
      ("Microphone permission was denied. Enable it in your browser
      settings to record.") and flips state to `error` so the overlay
      can show the red mic + error text.
    - `pause()` tears down the mic entirely (guarantees no audio leaves
      the browser while paused) — Phase 4e will swap this for the
      SleepDetector pause that keeps the graph open with KeepAlive
      frames.
    - Phase 4a synth transcript loop removed — transcripts now stay
      empty until Deepgram lands in Phase 4c; the overlay renders the
      "Listening…" placeholder while waiting.
    
    Why
    - A real VU meter driven by speech is a prerequisite for iOS parity
      (the mic halo reacts to volume in the iOS app) and for making the
      recording overlay feel responsive to the inspector.
    - Without real mic access we can't verify that getUserMedia works
      on the production PWA (HTTPS cert, iOS Safari permission flow,
      echo cancellation defaults) — Phase 4b proves the pipeline end-
      to-end even before Deepgram is wired up.
    
    Why this approach
    - Extracted `startMicCapture()` into its own module so Phase 4c can
      reuse the same handle to feed Deepgram Nova-3 via `onSamples` and
      Phase 4e can feed Silero VAD the same way — one audio graph,
      many consumers.
    - Kept `{ ideal: 16000 }` not bare `16000` per rules/mistakes.md —
      iOS Safari throws OverconstrainedError on bare values.
    - ScriptProcessor fallback retained (deprecated but widely
      supported) for older browsers where `audioWorklet.addModule`
      rejects; user-visible failure is worse than a deprecated API.
    - RMS smoothed with a 0.3 EMA — attacks feel immediate but silent
      blocks decay in <200ms, so the VU meter doesn't flicker at high
      frequencies.
    - Level push throttled to ~60Hz (16ms) on the React side — audio
      callbacks fire every ~8ms at 16kHz/128 samples, which would
      flood setState without throttling.
    - Listen to track 'ended' event so we surface "mic unplugged / OS
      muted" as an error instead of silently streaming silence.
    
    Context
    - This is Phase 4b of the web-rebuild. Phase 4c wires Deepgram
      Nova-3 via the same `onSamples` callback; Phase 4d wires the
      backend Sonnet multi-turn WS + field propagation back to
      JobContext; Phase 4e adds VAD sleep/wake.
```

## Files changed

```
 web/public/audio-worklet-processor.js |  26 +++++
 web/src/lib/recording-context.tsx     | 191 ++++++++++++++++++++--------------
 web/src/lib/recording/mic-capture.ts  | 155 +++++++++++++++++++++++++++
 3 files changed, 294 insertions(+), 78 deletions(-)
```
