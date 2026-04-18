# Phase 4e — Context

**Commit:** `9f1dba6`

## Commit message

```
commit 9f1dba67f72a6e675bd5cbab18a026c5b9ea048e
Author:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
AuthorDate: Fri Apr 17 13:30:22 2026 +0100
Commit:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
CommitDate: Fri Apr 17 13:30:22 2026 +0100

    feat(web): Phase 4e VAD sleep/wake with 3s ring buffer replay
    
    WHAT — Port iOS SleepManager + AudioRingBuffer to web so the recording
    pipeline auto-powers down during silence and re-wakes on speech, matching
    the three-tier active/dozing/sleeping power model. 15s of no-final-
    transcript triggers doze (Deepgram WS paused, Sonnet paused, cost ticker
    stopped); 30min of dozing triggers sleep (Deepgram + Sonnet fully
    disconnected, mic kept running); RMS heuristic on the live mic wakes
    back to active and replays the last 3s of audio into Deepgram so words
    spoken just before wake reach the ASR.
    
    WHY — The session would otherwise burn $0.0077/min of Deepgram spend
    plus Sonnet token cost for every minute of silence while the inspector
    is walking between rooms or writing notes. iOS ships this feature and
    inspectors expect the two clients to behave identically — without it
    the web session bill would be several multiples of the iOS session bill
    for the same job. Also, without the ring buffer replay every wake would
    lose the first 1–3s of the sentence that triggered it, which is what
    historically broke the first-utterance extraction on iOS before the
    AudioRingBuffer landed.
    
    WHY THIS APPROACH — Pause-via-flag-with-KeepAlive over WS-teardown
    because a fresh Deepgram handshake adds ~200ms of wake latency while
    a paused WS latches in <100ms. The SleepManager owns only timers and
    callbacks, never touches audio hardware directly — lets the provider
    decide what to tear down at each tier. Ring buffer always writes
    (including while paused/sleeping) so wake replay is consistent across
    both wake-from-doze and wake-from-sleep. Constants lifted 1:1 from
    iOS Sources/Audio/SleepManager.swift (noTranscriptTimeout 15s,
    dozingTimeout 1800s, energy floor 0.002, 12-frame wake window, 2s
    post-doze cooldown) so behaviour matches observationally.
    
    RMS wake is a deliberate first pass — iOS uses Silero VAD v5 ONNX which
    is more resistant to tool noise / breathing / footsteps. Shipping
    Silero on web requires adding onnxruntime-web + the model file to
    /public; deferred to a follow-up so this commit ships the whole
    state machine without a ~3MB asset dependency. TODO marked in
    sleep-manager.ts.
    
    FILES
    - NEW web/src/lib/recording/audio-ring-buffer.ts — Int16 circular
      buffer, writeFloat32() + drain() + reset()
    - NEW web/src/lib/recording/sleep-manager.ts — SleepManager class with
      onEnterDozing/onEnterSleeping/onWake callbacks
    - MODIFIED web/src/lib/recording/deepgram-service.ts — added pause(),
      resume(replay?), sendInt16PCM() for ring-buffer replay on wake
    - MODIFIED web/src/lib/recording-context.tsx — instantiate SleepManager
      on start(), route onFinalTranscript → onSpeechActivity, route
      onLevel → processAudioLevel, wire doze/sleep/wake callbacks,
      preserve mic + ring buffer across sleep so wake replay is valid
    
    Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

## Files changed

```
 web/src/lib/recording-context.tsx          | 212 +++++++++++++++++++++++++----
 web/src/lib/recording/audio-ring-buffer.ts |  64 +++++++++
 web/src/lib/recording/deepgram-service.ts  |  45 +++++-
 web/src/lib/recording/sleep-manager.ts     | 189 +++++++++++++++++++++++++
 4 files changed, 482 insertions(+), 28 deletions(-)
```
