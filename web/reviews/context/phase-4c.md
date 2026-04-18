# Phase 4c — Context

**Commit:** `9e93907`

## Commit message

```
commit 9e93907c8ea956d3343006338c80d67061e0005a
Author:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
AuthorDate: Fri Apr 17 12:58:20 2026 +0100
Commit:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
CommitDate: Fri Apr 17 12:58:20 2026 +0100

    feat(web): Phase 4c direct Deepgram Nova-3 WebSocket + live transcripts
    
    What
    - Add `web/src/lib/recording/deepgram-service.ts` — minimal direct-to-
      Deepgram Nova-3 WebSocket client. Mirrors iOS `DeepgramService.swift`
      protocol: same URL params (nova-3 / linear16 / 16kHz / en-GB /
      interim_results / endpointing=300 / utterance_end_ms=2000 /
      vad_events=true) and subprotocol auth (`['token', apiKey]`). Handles
      resampling (linear interp) and Float32→Int16 PCM conversion on the
      main thread. Includes KeepAlive loop (JSON + 500ms silence every 10s
      after 8s of idle) to prevent Deepgram's idle timeout from closing the
      stream during silence.
    - Extend `api.deepgramKey(sessionId)` on the typed API client — fetches
      a short-lived Nova-3 token from the backend `/api/deepgram-proxy`
      endpoint so the browser never sees the long-lived account key.
    - Wire the service into `RecordingProvider`:
        * generates a monotonic session id on `start()` (scoped token + will
          be the Sonnet extraction session id in Phase 4d)
        * opens the mic via AudioWorklet, then opens Deepgram WS with a
          freshly-minted scoped key and the mic's actual sample rate
        * routes each audio block to `deepgramRef.current.sendSamples()`
          via the existing `onSamples` callback
        * interim partials land in `interim` state; finals push onto the
          rolling `transcript[]` log (cap 10)
        * exposes `deepgramState` + `interim` on the context so the overlay
          and transcript bar can render live partials in grey italic above
          the finals log
    - Overlay now renders interim text on top of the final log (italic,
      secondary colour). Minimised transcript bar shows interim if present
      (italic) or the last final (regular).
    - `pause()` tears down both mic and WS so no audio/transcripts flow
      during doze. Phase 4e will swap for SleepDetector pause that keeps
      the WS open via KeepAlive to minimise wake-up latency.
    
    Why
    - Matches the iOS architecture (direct-to-Deepgram, scoped token,
      subprotocol auth) so the inspector gets the same <200ms partial
      latency on the web PWA they do on iOS. Bypassing a backend proxy
      also halves the audio-path bandwidth and avoids a single-region
      bottleneck.
    - Interim partials appearing in grey italic under (above) the finals
      is a well-known UX pattern — the inspector sees words materialising
      as they're spoken, then confirms visually when Deepgram finalises.
    
    Why this approach
    - Separate lightweight `DeepgramService` class rather than reusing the
      legacy `deepgram-service.ts` from `_archive/web-legacy` because:
        * auto-reconnect + pause/resume with KeepAlive belongs in Phase 4e
          where the SleepDetector orchestrates the lifecycle
        * the legacy service carried a lot of debug-panel coupling we
          don't want to port across to the new shell
    - Subprotocol auth (`new WebSocket(url, ['token', apiKey])`) — Deepgram
      no longer accepts `?token=` query params, and `Authorization` headers
      are stripped on iOS Safari during HTTP→WS upgrade (rules/mistakes.md).
    - Token comes from the backend `/api/deepgram-proxy` endpoint so the
      Deepgram account key never reaches the browser. Tokens are scoped
      (typically ~10 min expiry) — callers re-request on reconnect, which
      Phase 4e will handle automatically.
    - Resample + PCM conversion stays on the main thread (not in the
      worklet) — worklet is kept minimal for cacheability + auditability;
      resampling at 8ms-per-block is trivial CPU.
    - Error handler checks `deepgramRef.current` is still set before
      surfacing the error to UI — prevents a spurious red-flash when a
      normal CloseStream races with `stop()`.
    
    Context
    - This is Phase 4c of the web-rebuild. The backend `/api/deepgram-
      proxy` endpoint is assumed to exist (mirrors the iOS + legacy web
      contracts). If that endpoint is named differently in production,
      the `api.deepgramKey` method is the single point to update.
    - Phase 4d wires the backend Sonnet multi-turn extraction WebSocket
      (`/api/sonnet-stream`) and propagates extracted fields back into
      the JobContext so `updateJob()` gets called with structured
      circuit + test-reading data as Deepgram transcripts land.
    - Phase 4e ports SleepManager (dozing → sleeping → wake with VAD +
      ring buffer) from iOS.
```

## Files changed

```
 web/src/components/recording/recording-overlay.tsx |  42 ++--
 web/src/components/recording/transcript-bar.tsx    |  15 +-
 web/src/lib/api-client.ts                          |  12 +
 web/src/lib/recording-context.tsx                  | 177 +++++++++----
 web/src/lib/recording/deepgram-service.ts          | 280 +++++++++++++++++++++
 5 files changed, 457 insertions(+), 69 deletions(-)
```
