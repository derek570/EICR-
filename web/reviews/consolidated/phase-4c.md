# Phase 4c — Consolidated Review: Direct Deepgram Nova-3 WebSocket + Live Transcripts

**Commit:** `9e93907`
**Sources:** `web/reviews/claude/phase-4c.md`, `web/reviews/codex/phase-4c.md`, `web/reviews/context/phase-4c.md`
**Scope:** Review scored against the state of code at commit `9e93907`. The working tree has moved on (4d/4e add `pause/resume` with KeepAlive, `sendInt16PCM`, sonnet/sleep integration); those additions are excluded from the 4c verdict.

---

## 1. Phase summary

Phase 4c introduces a minimal browser-to-Deepgram Nova-3 WebSocket client (`deepgram-service.ts`, 229 LOC new), wires it into `RecordingProvider`, and renders interim/final transcripts in the full overlay and minimised transcript bar. The URL parameters mirror the iOS streaming URL (nova-3, linear16, 16 kHz, en-GB, interim_results, endpointing=300, utterance_end_ms=2000, vad_events, smart_format, punctuate, numerals). Auth uses WebSocket subprotocol `['token', apiKey]` rather than an `Authorization` header, which correctly follows `rules/mistakes.md` (iOS Safari strips headers during HTTP->WS upgrade). Tokens are minted by a backend proxy so the long-lived Deepgram account key never reaches the browser. Auto-reconnect, pause-with-KeepAlive, ring-buffer replay, SleepManager, Sonnet integration, keyterm prompting, and token refresh are explicitly deferred to 4d/4e.

---

## 2. Agreed findings

| # | Severity | Area | File:line | Summary |
|---|----------|------|-----------|---------|
| A1 | P1 | Correctness / race | `web/src/lib/recording-context.tsx:193-215` (Claude), `:159-194,221-289` (Codex) | `start()` / `resume()` / `beginMicPipeline()` have no generation or cancellation guard around their awaited steps. If the user stops, pauses, or the provider unmounts during `getUserMedia`, `api.deepgramKey()`, or WS open, the stale continuation still assigns `micRef` / `deepgramRef` and resurrects a "zombie" mic stream + WebSocket. Mirror iOS's `session === self.urlSession` guard (`DeepgramService.swift:832`). |
| A2 | P2 | Accessibility | `web/src/components/recording/recording-overlay.tsx:139-173` | Transcript container has no `aria-live="polite"` region, so screen-reader users get no announcement of the core Phase 4c feature. Interim updates should be suppressed from announcement to avoid over-announcement. |
| A3 | P2 | Performance | `web/src/lib/recording/deepgram-service.ts:108-127,220-232` | Per-block allocations on the hot audio path: fresh `Int16Array` in `sendSamples` and fresh `Float32Array` in `resampleTo16k` every 8 ms block. Steady GC churn; reuse instance-level scratch buffers. |
| A4 | P2 | Test coverage | `web/src/lib/recording/` (no test file) | No unit tests added for this phase. Most acute gaps: `DeepgramService` message parsing (Results / SpeechStarted / UtteranceEnd / Error / Metadata); `buildURL` snapshot; provider start/stop/pause/resume lifecycle; failure-state transitions. |

---

## 3. Disagreements + adjudication

### D1 — How the auth scheme vs. token type should be framed (P0 in both reviews, different framings)

- **Claude (§3.1, top priority 1):** `['token', apiKey]` subprotocol is a latent P0 bug *if* the proxy returns a JWT; advises switching to `['bearer', apiKey]` or proving the proxy returns a raw key. Cites iOS history note: "JWT+Token=401, JWT+Bearer=connected."
- **Codex:** doesn't call out auth-scheme mismatch explicitly but flags the doc drift between `/api/proxy/deepgram-streaming-key` (README) and `/api/deepgram-proxy` (code).

**Adjudication — verified against source:**

I verified `CertMateUnified/Sources/Services/DeepgramService.swift:228-235` and `src/routes/keys.js:318-354,356-396`:
- The iOS streaming client uses `Authorization: Bearer <apiKey>` (header auth), not subprotocol auth.
- The backend's token minter at `POST /proxy/deepgram-streaming-key` calls Deepgram `/v1/auth/grant` and returns the JWT `access_token`, **with a master-raw-key fallback** if grant fails (`keys.js:370-375`).
- The web client calls `GET /api/deepgram-proxy?sessionId=...` (`web/src/lib/api-client.ts:144-147`).

Two problems converge:
1. **Endpoint contract mismatch (Codex, upgraded to P0):** The web client's `GET /api/deepgram-proxy` does not match the actual backend route `POST /api/proxy/deepgram-streaming-key`. Either the endpoint doesn't exist or a separate proxy was added unseen; either way the typed contract in `api-client.ts:144-147` is fictional relative to `src/routes/keys.js`.
2. **Auth-scheme gamble (Claude, P0 confirmed):** *If* the endpoint is wired up and returns a JWT, `new WebSocket(url, ['token', jwt])` will 401 at the WS upgrade — the exact pitfall the iOS history note documents. On the fallback branch where the backend returns the raw master key, `['token', rawKey]` would succeed — so the bug is load-bearing on which branch the backend takes.

**Verdict:** Both concerns are real. Merge them into a single **P0 endpoint+scheme contract** item; the fix is (a) align the web client to the actual backend path, (b) clarify the token type the endpoint returns, (c) use `['bearer', jwt]` when it's a JWT and `['token', rawKey]` when it's a master-key fallback, and (d) add a smoke test that the WS actually connects.

### D2 — Severity of the Deepgram failure -> session state behaviour

- **Codex (P1):** Deepgram socket/message failure only stores `errorMessage`; `state` remains `active`, hero pill still says "Recording", mic stays open, billing timer keeps running. User sees a live recorder that is silently broken.
- **Claude (P1 §3.3, §3.5):** flags `onerror` -> `onclose` duplicate-error surfacing and the `deepgramRef.current` nulling race, but does *not* make the stronger "session state should go to `error`" point.

**Adjudication:** Codex is correct and this deserves a standalone P1. The provider treats Deepgram as a non-fatal subsystem, which is wrong for Phase 4c where transcription *is* the product. Keep Codex's framing; Claude's `onerror/onclose` dedupe and `closing` flag are subordinate code-level fixes that should happen together with the state transition.

### D3 — Initial-audio loss before WS is connected

- **Codex (P1):** `sendSamples()` drops everything until `state === 'connected'`. On a slow token fetch or WS handshake, the first words of the first utterance disappear silently.
- **Claude:** does not raise this; mentions token-fetch-then-mic sequencing (§3.10 P2) as a different angle.

**Adjudication:** Codex's finding is substantive and not covered by Claude. Keep as P1. Fix options: (a) buffer outbound PCM in-memory until `onopen`, or (b) don't transition the provider to `active` until WS is open. Combines nicely with Phase 4e's planned ring-buffer.

### D4 — Token-fetch sequencing (mic-first vs. key-first)

- **Claude (P2 §3.10):** recommends fetching key first so user doesn't grant mic permission only to see a failure 1 s later.
- **Codex:** doesn't raise this but also doesn't contradict.

**Adjudication:** Accept as P2 UX polish. Minor; agree with Claude.

### D5 — POST vs. GET for token minting

- **Codex (P2):** temp credentials should not be minted via a cacheable `GET`; use `POST` with `cache: 'no-store'`.
- **Claude:** doesn't raise this.

**Adjudication:** Codex is right in principle, and verification confirms the actual backend already uses `POST /proxy/deepgram-streaming-key`. The fix is therefore part of D1 (align the web client to the real endpoint, which is already POST). No separate action needed beyond D1.

---

## 4. Claude-unique findings

| # | Severity | Area | File:line | Summary |
|---|----------|------|-----------|---------|
| C1 | P1 | Correctness | `web/src/lib/recording/deepgram-service.ts:86-100` | `onerror` sets `state='error'`; browsers always fire `close` after `error`. `onclose` still calls `onError` a second time with `Deepgram WS closed (code=1006)`, producing two error surfaces for the same underlying failure. Add an `errorFired` flag; `onclose` suppresses its `onError` when set. |
| C2 | P1 | Correctness | `web/src/lib/recording/deepgram-service.ts:239-249` | KeepAlive loop has no back-pressure check on `ws.bufferedAmount`. A throttled/background tab or a zombie WS (interacts with A1) accumulates 16 KB every 10 s and holds the service alive via `setInterval` closure. Skip the send when `bufferedAmount > 32 KB`. |
| C3 | P1 | Correctness | `web/src/lib/recording-context.tsx:161-170`, `deepgram-service.ts:165-192` | `deepgramRef.current=null` is used as an implicit "we're closing" flag to suppress red-flash on normal CloseStream races. This conflates "we're closing" with "there is no service" and also silences genuine server errors in the 300 ms graceful-close window. Introduce an explicit `closingRef` / `isStoppingRef`. |
| C4 | P2 | Correctness | `web/src/lib/recording/deepgram-service.ts:220-232` | Linear-interpolation resampler assumes `sourceSampleRate >= 16 kHz`. On 8 kHz Bluetooth mics the output becomes a plateau of the last sample. Throw or log on upsampling. Also add a comment acknowledging the no-anti-alias-filter trade-off. |
| C5 | P2 | Parity | `web/src/lib/recording/deepgram-service.ts:202-218` | No `keyterm` / keyword-boost support. iOS appends up to ~89 keyterms with URL-length-aware truncation and boost suffixes — the single biggest Nova-3 quality lever for EICR vocabulary (RCDs, BS 7671, Zs/Ipf/EFLI, cable sizes). Fine to defer, but add a TODO and a ticket; requires a shared vocabulary source in `packages/shared-utils`. |
| C6 | P2 | Parity | `web/src/lib/recording/deepgram-service.ts:275-276` | Empty-transcript Results are dropped entirely. Deepgram emits empty finals on `UtteranceEnd` in some configs — Phase 4d/4e Sonnet + SleepDetector flows may care. Route empty finals through when `is_final || speech_final`. |
| C7 | P2 | Parity | `web/src/lib/recording/deepgram-service.ts:278-306` | `speech_final` flag not surfaced. iOS logs it to distinguish true utterance-end from rolling interim-final. Expose as `onSpeechFinal` or add to the `onFinalTranscript` signature — needed by Phase 4e SleepDetector. |
| C8 | P2 | Perf | `web/src/lib/recording/mic-capture.ts:68-72` vs `recording-context.tsx:297-298` | Sample-rate mismatch: mic requests `{ ideal: 16000 }` but iOS Safari often ignores it and opens at 48 kHz device rate, tripling WS send frequency. Functional but worth benchmarking. |
| C9 | P2 | Accessibility | `web/src/components/recording/recording-overlay.tsx:170-176` | `dismissQuestion` button is 24x24, below the 44x44 mobile touch-target minimum in CLAUDE.md design rules. Bump to `h-11 w-11` or extend hit area via CSS. |
| C10 | P2 | Accessibility | `web/src/components/recording/recording-overlay.tsx:82-85` | Overlay `aria-label="Recording session"` is static; when `state='error'` the label doesn't reflect it. Tie to dynamic state. |
| C11 | P2 | Code quality | `web/src/lib/recording-context.tsx:151` | Transcript `id` uses `u_${Date.now()}_${prev.length+1}`. Two rapid finals in the same millisecond batched by React can collide. Use `crypto.randomUUID()` with a fallback. |
| C12 | P2 | Code quality | `web/src/lib/recording/deepgram-service.ts:262-296` | `Record<string, unknown>` casts in `handleMessage` are brittle; a small Zod schema or hand-rolled type guard would catch schema drift. Also: unknown message types are silently dropped; iOS logs them (`DeepgramService.swift:604-606`) — add a DEV-only `console.debug`. |
| C13 | P2 | Security | `web/src/lib/recording-context.tsx:189-192` | Session id is `Date.now() + Math.random()`. Fine for correlation; use `crypto.randomUUID()` if it ever becomes security-load-bearing. |
| C14 | P2 | Security | `web/src/lib/recording-context.tsx:159-194` | No debounce / rate limit on `start()`; double-click or error->error loop mints fresh tokens each time. Low impact; debounce the Start button. |

---

## 5. Codex-unique findings

| # | Severity | Area | File:line | Summary |
|---|----------|------|-----------|---------|
| X1 | P1 | Correctness / state | `web/src/lib/recording-context.tsx:183-190,233-236`, `deepgram-service.ts:82-95,271-274` | Deepgram transport failure doesn't transition provider `state` to `error`, doesn't clear the tick, doesn't tear down mic/socket, doesn't distinguish clean vs. error close. Hero pill stays "Recording", cost keeps incrementing, inspector has no idea transcription is dead. (See D2.) |
| X2 | P1 | Correctness | `web/src/lib/recording-context.tsx:198-219`, `deepgram-service.ts:103-120` | Audio is captured and sent into `sendSamples()` before the WS has opened; everything up to `state === 'connected'` is dropped. First words of the first utterance are silently lost on slow token fetch / handshake. Buffer PCM until `onopen`, or defer `state='active'` until WS is open. (See D3.) |
| X3 | P2 | Correctness | `web/src/lib/recording/deepgram-service.ts:124-148` | `disconnect()` schedules a delayed `setState('disconnected')` 300 ms later. If a new `DeepgramService` is opened before that fires, the stale instance's timeout can push the global `deepgramState` back to `disconnected`. Track the timeout id and clear it, or guard `onStateChange` with an instance token. |
| X4 | P2 | Code quality / drift | `web/src/lib/recording-context.tsx:63-65,101,302` | `deepgramState` is threaded through the provider but never rendered by any Phase 4c UI despite the "for debugability" comment. Dead public surface; either wire it up or drop the comment. |
| X5 | P2 | Doc drift | `web/README.md:69` | README documents `/api/proxy/deepgram-streaming-key`; code calls `/api/deepgram-proxy`. Integration risk. (Subsumed by D1 — the real backend is at yet a third path: `POST /api/proxy/deepgram-streaming-key`.) |
| X6 | P2 | Perf / re-renders | `web/src/lib/recording-context.tsx:294-328` | Entire `RecordingProvider` value object rebuilds on every mic-level tick, elapsed tick, interim update, and Deepgram state change. Phase 4c materially increases update frequency, so all `useRecording()` consumers rerender on every tick. Split into "hot" / "cold" context slices, or use context selectors. (Claude mentions this too in Performance §5 as a future concern rather than a current finding; treat as shared.) |
| X7 | P2 | Accessibility | `web/src/components/recording/transcript-bar.tsx:30-56` | Minimised bar's accessible name is always "Expand recording overlay"; no live state (elapsed, interim, last final) is exposed via `aria-label` / `aria-describedby`. Live status largely invisible to AT. |

---

## 6. Dropped / downgraded

| # | Origin | Original severity | Adjudicated | Rationale |
|---|--------|-------------------|-------------|-----------|
| DR1 | Claude §3.1 (auth scheme) | P0 standalone | Merged into D1 (still P0) | Real, but converges with Codex's endpoint-drift finding. Address as one contract item. |
| DR2 | Codex security P2 (GET-cacheable token) | P2 standalone | Merged into D1, effectively dropped | The actual backend is already `POST`. Fix lands automatically when web client is aligned. |
| DR3 | Codex X5 (README drift) | P2 | Subsumed into D1 | Same root cause: the web client's assumed contract doesn't match reality. Single fix resolves both. |
| DR4 | Claude §7 nits (underscore-prefixed `_state`, `onError: () => {}` defaults, `deepgram-service.ts:42` comment depth, subprotocol devtools visibility) | unranked nits | Dropped | Cosmetic; not worth tracking. |
| DR5 | Claude §4 security bullets (Session id non-crypto, no `start()` rate limit, verbatim `onError` message) | informational | Kept as C13/C14 but flagged low impact | React escapes text so no XSS; rate limit is theoretical. |
| DR6 | Claude §3.11 (sample-rate mismatch) | P2 | Kept as C8 but downgraded to "benchmark" | Functional; only a perf concern on iOS Safari. |

---

## 7. Net verdict + top 3 priorities

**Verdict: Needs rework before production.**

Protocol-level mirroring of iOS is solid and the deferred items (reconnect, pause-with-KeepAlive, ring-buffer, Sonnet) are correctly scoped out. However, three issues — the endpoint/auth contract mismatch, the async-cancellation race, and the "Deepgram failed but UI still says Recording" state bug — are each individually sufficient reason not to ship 4c as-is. Codex's "Needs rework" stance is the correct call; Claude's "Ship-worthy" stance is too generous given the endpoint-contract gap uncovered during verification.

### Top 3 priorities

1. **Fix the endpoint + auth-scheme contract (D1 / merged P0).**
   The web client calls `GET /api/deepgram-proxy?sessionId=...` but the real backend route is `POST /proxy/deepgram-streaming-key`, which returns a JWT (with raw-master-key fallback). Action: (a) align `web/src/lib/api-client.ts:144-147` to the actual backend path, method, and body; (b) type the response to surface the token kind (`{ key: string; scheme: 'bearer' | 'token' }`); (c) pass the matching subprotocol in `deepgram-service.ts:74` — `['bearer', jwt]` for JWTs, `['token', rawKey]` for the fallback; (d) add an end-to-end smoke test that the WS actually opens.

2. **Guard async lifecycle against cancellation (A1 / Codex #1 + Claude #2).**
   Snapshot `sessionIdRef.current` (or a captured `cancelled` boolean) at the top of `start()`, `resume()`, and `beginMicPipeline()`. After every `await` (`getUserMedia`, `api.deepgramKey()`, `ws` open), bail if the session has changed — and tear down anything the late await just created. Mirror iOS's `session === self.urlSession` pattern (`DeepgramService.swift:832`).

3. **Fail the session cleanly when Deepgram fails (X1 / D2).**
   Treat Deepgram transport + message errors as fatal for the current session: set provider `state` to `error`, stop the elapsed/cost tick, tear down mic + socket, distinguish clean vs. error close. Pairs with C1 (dedupe `onerror` + `onclose`) and C3 (explicit `closingRef`).

---

*Adjudication verified against:*
- *`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/Sources/Services/DeepgramService.swift:228-235,482-495,500-528,604-606,620,643,832`*
- *`/Users/derekbeckley/Developer/EICR_Automation/src/routes/keys.js:183-198,283-315,318-354,356-396`*
- *`/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/api-client.ts:144-147`*
