# Phase 4d — Context

**Commit:** `b6c4b65`

## Commit message

```
commit b6c4b658da3ed1fd27bdf8bf5eb6dc6099712c6c
Author:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
AuthorDate: Fri Apr 17 13:20:08 2026 +0100
Commit:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
CommitDate: Fri Apr 17 13:20:08 2026 +0100

    feat(web): Phase 4d server-side Sonnet multi-turn extraction + field propagation
    
    Completes the recording pipeline at parity with iOS: Deepgram finals feed
    a server-side Sonnet WebSocket, structured readings flow back and merge
    into the active JobDetail, gated questions surface in the overlay, and
    session_pause/resume hooks align cost tracking across doze/wake
    transitions (ready for Phase 4e).
    
    **Why:** Phase 4c delivered live transcripts but the form fields still
    had to be typed by hand — the critical "voice-drives-the-certificate"
    loop that makes the product valuable to inspectors was not yet closed.
    The server already exposes the multi-turn Sonnet session at
    /api/sonnet-stream; iOS has used it for over a year. This plugs the web
    frontend into the same contract so every final transcript that rolls
    off Deepgram also fans out to Sonnet for structured extraction.
    
    **What:**
    
    - New `web/src/lib/recording/sonnet-session.ts` — WebSocket client for
      `/api/sonnet-stream`. Uses URL-query `?token=<jwt>` auth (browsers +
      iOS Safari both strip Authorization headers on WS upgrade — see
      rules/mistakes.md). Handles session_start / transcript / pause /
      resume / stop / correction / job_state_update outbound; session_ack /
      extraction / question / voice_command_response / cost_update / error
      inbound. Pre-connect transcript queueing so nothing said in the first
      ~200ms of the handshake is lost.
    
    - New `web/src/lib/recording/apply-extraction.ts` — routes each
      ExtractedReading to the right JobDetail section (supply, board,
      installation, extent, design) for circuit 0, and to the matching
      CircuitRow for circuits >= 1. Implements 3-tier priority: pre-existing
      manual/CCU values win over fresh Sonnet readings (Sonnet dedupes
      server-side but the user might have typed a correction since the last
      job_state_update landed). Also handles `circuit_updates` (create /
      rename designations), `field_clears`, and dedup of `observations`.
    
    - `recording-context.tsx`:
      - Pulls `useJobContext()` to access job + updateJob. Mirrors both into
        refs so Sonnet callbacks don't rebind every render.
      - Opens SonnetSession alongside Deepgram inside beginMicPipeline —
        sequential on purpose so the scoped Deepgram token fetch doesn't
        contend with the Sonnet WS handshake on slow networks.
      - Routes onFinalTranscript into sonnetRef.sendTranscript().
      - Tracks Sonnet cost separately (server is authoritative via
        totalJobCost) and sums it with the live Deepgram ticker for a
        single user-facing `costUsd`. Keeps the Deepgram ticker smooth
        between extraction turns.
      - pause() sends session_pause BEFORE tearing down the WS (iOS fix
        4c75ccf — cost tracker needs to stop BEFORE the socket closes so
        the ack lands). resume() re-opens and sends session_resume. Server
        re-uses the existing Sonnet session by sessionId within the 5-min
        reconnect window (sonnet-stream.js).
      - New `questions` queue + `dismissQuestion` action — gated questions
        from Sonnet are deduped by text and capped at 5.
      - New `sonnetState` exposed for overlay diagnostics.
    
    - `recording-overlay.tsx` — renders a blue question strip above the
      transcript log when `questions.length > 0`, with a × button per row
      that dispatches `dismissQuestion`. Uses aria-live="polite" so screen
      readers announce new questions.
    
    **Trade-offs:**
    
    - Did NOT wire live `job_state_update` for every updateJob — would flood
      the WS and could cause a feedback loop (Sonnet extracts → updateJob →
      fires job_state_update → Sonnet snapshots → extracts ...). The
      initial jobState sent on session_start is enough for now; manual
      edits during recording will be picked up on the next reconnect.
    - Field routing for circuit 0 is hard-coded to a 60-entry map rather
      than inferred from backend field_reference.md. This mirrors the iOS
      approach and keeps the client independent of server shape drift.
    
    Unblocks Phase 4e (VAD sleep/wake) — the Sonnet pause/resume path is
    already exercised by the existing pause/resume actions, so 4e just has
    to drive them automatically.
```

## Files changed

```
 web/src/components/recording/recording-overlay.tsx |  45 ++-
 web/src/lib/recording-context.tsx                  | 171 +++++++++-
 web/src/lib/recording/apply-extraction.ts          | 316 +++++++++++++++++
 web/src/lib/recording/sonnet-session.ts            | 375 +++++++++++++++++++++
 4 files changed, 895 insertions(+), 12 deletions(-)
```
