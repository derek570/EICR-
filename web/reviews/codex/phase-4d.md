**Review scope**

`recording-context.tsx` and `apply-extraction.ts` have evolved further in the working tree since `b6c4b65` (Phase 4e/live-fill work), so the findings below are anchored to the `b6c4b65` snapshot and cross-checked against the current backend contract.

## 1. Summary of the phase

Phase 4d closes the core “voice fills the certificate” loop on the web client. It adds a browser Sonnet WebSocket client, forwards final Deepgram transcripts to it, maps returned structured readings into `JobDetail`, surfaces Sonnet questions in the recording overlay, and rolls Sonnet cost into the recording cost display.

## 2. Alignment with original plan

Mostly aligned with the handoff doc and commit intent. The four promised deliverables landed: Sonnet WS client, extraction-to-job mapper, recording context integration, and overlay question rendering.

Two objectives do not fully hold up in the implementation:
- The intended pause/resume parity with iOS is not actually achieved, because the pause path stops the server session instead of preserving it.
- The intent to support both EICR and EIC extraction is undermined by sending the wrong certificate-type shape to the backend, which defaults the session to the EICR prompt.

## 3. Correctness issues

- `[P1]` Manual pause destroys the Sonnet session instead of pausing it. In `web/src/lib/recording-context.tsx:384-402`, `pause()` sends `session_pause` and then immediately calls `teardownSonnet()`. `teardownSonnet()` calls `disconnect()`, which sends `session_stop` in `web/src/lib/recording/sonnet-session.ts:253-279`. On the server, `session_stop` deletes the active session in `src/extraction/sonnet-stream.js:403-405,780-783`. That contradicts the handoff’s “5-minute reconnect window” intent and breaks multi-turn continuity across manual pause/resume.
- `[P1]` `session_resume` is dropped on every resume. `resume()` in `web/src/lib/recording-context.tsx:404-415` calls `beginMicPipeline()` and then immediately `sonnetRef.current?.resume()`. But `SonnetSession.resume()` only sends when `state === 'connected'` (`web/src/lib/recording/sonnet-session.ts:247-250`), while `connect()` is still in `'connecting'` until `onopen` (`:147-186`). Result: the resume signal is silently lost.
- `[P1]` EIC sessions are started with the wrong certificate type. The client sends raw `jobRef.current` as `jobState` (`web/src/lib/recording-context.tsx:301-305`), where the field is `certificate_type`. The server reads `jobState?.certificateType` in `src/extraction/sonnet-stream.js:445-485` and otherwise falls back to `'eicr'` (`:483`). That means EIC jobs will use the EICR extraction prompt unless something else rewrites the shape first.
- `[P2]` Observation dedupe is too aggressive and can drop real defects. `web/src/lib/recording/apply-extraction.ts:233-259` dedupes solely by lowercased observation text, ignoring `location`, `schedule_item`, and `code`. Two identical observations in different locations will collapse into one row.

## 4. Security issues

- `[Medium]` JWT is placed in the WebSocket query string in `web/src/lib/recording/sonnet-session.ts:290-296`. That is vulnerable to leakage via reverse-proxy access logs, infrastructure tracing, and URL capture tooling. If query auth is unavoidable for browser WS upgrades, this should be a short-lived one-time ticket rather than the bearer JWT itself.
- `[Low]` The WS target is derived directly from `api.baseUrl` in `web/src/lib/recording/sonnet-session.ts:290-296`. A misconfigured `NEXT_PUBLIC_API_URL` would send both transcript data and auth material to an unintended host. That is more of a deployment hardening issue than an exploit in normal operation.

## 5. Performance issues

- `[P2]` This phase increases full job-tree rerenders during recording. `applyExtractionToJob()` returns whole section objects / full `circuits` arrays, and `updateJob()` does a top-level shallow merge in `web/src/lib/job-context.tsx:55-58`. During active extraction this will rerender all `useJobContext()` consumers, not just the fields that changed.
- `[P2]` `applyCircuitReadings()` always clones the `circuits` array when any per-circuit update/clear is present (`web/src/lib/recording/apply-extraction.ts:172-230`), even when the effective result is a no-op. That creates avoidable work during noisy or duplicate Sonnet turns.

## 6. Accessibility issues

No clear new accessibility regression in this phase. The added question strip is reasonably implemented:
- `aria-live="polite"` on the question container in `web/src/components/recording/recording-overlay.tsx:155-158`
- Explicit dismiss button labels in `:172-179`

Residual risk: the overlay still appears to be a modal without explicit focus trapping/restoration, but that predates this phase rather than being introduced by it.

## 7. Code quality

- `web/src/lib/recording/sonnet-session.ts:149` stores `startOptions` but never uses it.
- `web/src/lib/recording/sonnet-session.ts:361-362` casts inbound `cost_update` blindly to `CostUpdate`, bypassing the type’s literal guarantees.
- `web/src/lib/recording/apply-extraction.ts:35-38` hard-codes circuit-0 routing and falls back unknown fields to `supply`; that is an intentional trade-off, but it is drift-prone and can silently mis-route new backend fields.

## 8. Test coverage gaps

- No frontend tests were added for `SonnetSession` lifecycle: connect, pre-connect transcript queueing, pause/resume, reconnect, and close handling.
- No unit tests cover `applyExtractionToJob()` for section routing, manual-value preservation, `field_clears`, `circuit_updates`, or observation dedupe.
- No integration test verifies the frontend/server contract for `jobState`, especially the `certificateType`/`certificate_type` mismatch.
- No regression test covers the manual pause/resume path against the server’s `activeSessions` behaviour.

## 9. Suggested fixes

1. `web/src/lib/recording-context.tsx:384-402` and `web/src/lib/recording/sonnet-session.ts:253-279`  
   Change manual pause so it does not call the `session_stop` path. Either keep the Sonnet WS open after `session_pause`, or add a disconnect mode that closes the socket without sending `session_stop`.  
   Why: current pause destroys the multi-turn session and breaks the advertised reconnect window.

2. `web/src/lib/recording/sonnet-session.ts:247-250` and `web/src/lib/recording-context.tsx:404-415`  
   Queue `session_resume` until the socket reaches `connected`, or send it from `onSessionAck('reconnected')` / `onopen`.  
   Why: the current resume call races with connection establishment and is dropped.

3. `web/src/lib/recording-context.tsx:301-305`  
   Send a normalized `jobState` shape that includes `certificateType: jobRef.current.certificate_type`, or update the server to accept `certificate_type` too.  
   Why: EIC sessions currently fall back to the EICR extractor.

4. `web/src/lib/recording/apply-extraction.ts:233-259`  
   Deduplicate observations using `schedule_item + code`, or `location + text prefix`, matching the stronger strategy already used in `apply-document-extraction.ts:283-339`.  
   Why: text-only dedupe collapses distinct defects at different locations.

5. `web/src/lib/recording/sonnet-session.ts:290-296`  
   Replace query-string JWT auth with a short-lived WS ticket endpoint, or at minimum constrain/validate the host in production before opening the socket.  
   Why: reduces bearer-token exposure and accidental exfiltration to a misconfigured host.

6. `web/src/lib/recording/apply-extraction.ts:166-230`  
   Return `null` when `circuit_updates` / `field_clears` produce no effective changes instead of always returning a cloned array.  
   Why: avoids unnecessary `updateJob()` calls and broad rerenders during recording.

7. `web/src/lib/recording/sonnet-session.ts` and `web/src/lib/recording/apply-extraction.ts`  
   Add unit tests for WS lifecycle and extraction mapping, plus one integration test that pauses/resumes and confirms the server keeps exactly one logical session alive.  
   Why: these bugs are protocol-level and easy to miss manually.

## 10. Overall verdict

**Needs rework.**

Top 3 priority fixes:
1. Fix pause/resume so manual pause preserves the Sonnet session and resume reliably sends `session_resume`.
2. Fix the `certificateType` / `certificate_type` contract mismatch so EIC jobs use the correct extractor.
3. Fix observation dedupe so identical descriptions in different locations are not lost.