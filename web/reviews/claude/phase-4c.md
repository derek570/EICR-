# Phase 4c Review — Direct Deepgram Nova-3 WebSocket + Live Transcripts

**Commit:** `9e93907`
**Target files (as of commit 9e93907):**
- `web/src/lib/recording/deepgram-service.ts` (new, 229 LOC)
- `web/src/lib/recording-context.tsx` (+108 / −59)
- `web/src/lib/api-client.ts` (+12)
- `web/src/components/recording/recording-overlay.tsx` (+24 / −14)
- `web/src/components/recording/transcript-bar.tsx` (+10 / −4)

Review is scoped to the state of code *at 9e93907*; where the current working tree (after 4d/4e) adds `pause/resume`, `sendInt16PCM`, sonnet/sleep integration, etc., those additions are deliberately excluded from the 4c correctness verdict but noted in "Alignment" to flag items Phase 4c deferred.

---

## 1. Summary

Phase 4c is a tight, well-scoped slice that does exactly what the commit message promises: a minimal direct-to-Deepgram Nova-3 WebSocket client wired into `RecordingProvider`, with interim/final transcript plumbing into the overlay and minimised transcript bar. The URL params are byte-for-byte aligned with the iOS `DeepgramService.swift` streaming URL builder (`nova-3 / linear16 / 16kHz / mono / en-GB / interim_results / endpointing=300 / utterance_end_ms=2000 / vad_events=true / smart_format / punctuate / numerals`) and the ephemeral-token exchange goes through the backend proxy so the long-lived Deepgram key never reaches the browser. Auth uses WebSocket subprotocol (`['token', apiKey]`) instead of the `Authorization` header — this correctly follows `rules/mistakes.md` (iOS Safari strips headers during the HTTP→WS upgrade).

The code is clean, commented, and sized appropriately for a "minimum viable" slice; auto-reconnect, pause/resume, and the ring-buffer replay are explicitly deferred to Phase 4e. There are a handful of real correctness issues worth flagging (one P0 auth-scheme mismatch with iOS, one P1 state-machine race on rapid stop→error, a couple of P2 resampler / keyterm parity items) but nothing that blocks the slice.

---

## 2. Alignment with Phase 4c intent

Commit-message promises vs. delivered:

| Promise | Delivered? | Notes |
|---|---|---|
| Mirror iOS URL params | Yes | `deepgram-service.ts:202-216` exactly matches `DeepgramService.swift:482-495` (12 params in the same order). |
| Subprotocol auth `['token', apiKey]` | Yes | `deepgram-service.ts:74`. |
| Resample + Float32→Int16 on main thread | Yes | `deepgram-service.ts:108-127` + `resampleTo16k` at `:220-232`. |
| KeepAlive loop (JSON + 500ms silence every 10s after 8s idle) | Yes | `deepgram-service.ts:237-250`. |
| `api.deepgramKey(sessionId)` | Yes | `api-client.ts:119-131` (commit diff lines). |
| Session id generated on `start()` | Yes | `recording-context.tsx:193-195` at commit 9e93907. |
| Interim partials → `interim` state | Yes | `recording-context.tsx:141-143`. |
| Finals → rolling log capped at 10 | Yes | `recording-context.tsx:146-157`. |
| Overlay renders interim italic grey above final log | Yes | `recording-overlay.tsx:146-171` (post-diff). |
| Transcript bar prefers interim | Yes | `transcript-bar.tsx:23-25`, italic styling at `:49-53`. |
| Pause tears down mic + WS | Yes | `recording-context.tsx:234-244` at commit. |
| Auto-reconnect deferred to 4e | Yes | Explicitly called out; no reconnect in this slice. |

Deliberately *not* in scope for 4c (correctly deferred): pause-with-KeepAlive, `sendInt16PCM` replay path, `sleep-manager`, `sonnet-session`, `audio-ring-buffer`, keyterm prompting, adaptive sample-rate tracking, token refresh. All of these show up in the working-tree version post-4d/4e, which confirms 4c respected its boundary.

---

## 3. Correctness

### P0

**3.1 Subprotocol auth scheme diverges from iOS — JWT vs raw key confusion risk.**
The iOS client uses `Authorization: Bearer <apiKey>` and the in-file history note (`DeepgramService.swift:228-233`) explicitly states:

> "Backend returns JWT access tokens from Deepgram /v1/auth/grant. JWTs require `Bearer` prefix — `Token` only works with raw Deepgram API keys. Confirmed via Node.js test: JWT+Token=401, JWT+Bearer=connected."

The web client (`deepgram-service.ts:74`) uses `new WebSocket(url, ['token', apiKey])`. Deepgram's streaming docs accept *both* `token` and `bearer` in the WS subprotocol position, but they map to the same two distinct credential classes the iOS history warns about:
- `['token', rawApiKey]` → works with long-lived Deepgram API keys
- `['bearer', jwt]` → works with short-lived `/v1/auth/grant` JWTs

If `/api/deepgram-proxy` returns JWT access tokens (which the iOS proxy does, per the history note), then `['token', jwt]` will 401 at the WS upgrade — same failure mode iOS hit in commit `bbd8e69`. The commit message says "tokens are scoped (typically ~10 min expiry)" which is consistent with JWTs, not raw API keys — so this is very likely a latent bug the moment the proxy returns a JWT.

**File:line:** `web/src/lib/recording/deepgram-service.ts:74`
**Fix:** either (a) verify `/api/deepgram-proxy` returns a raw API key (not a JWT) and add a test that asserts the connection succeeds end-to-end; or (b) switch to `['bearer', apiKey]` to match iOS. The typed API signature `deepgramKey(sessionId): Promise<{ key: string }>` (`api-client.ts:124-127`) is ambiguous — rename to clarify what kind of credential is returned and consider returning `{ key, scheme: 'token' | 'bearer' }`.

### P1

**3.2 `stop()` during `'requesting-mic'` has no early-exit and can race with `beginMicPipeline` resolving.**
`recording-context.tsx:193-215` (commit 9e93907) sets `state = 'requesting-mic'`, awaits `beginMicPipeline()` (which awaits both `getUserMedia` and `openDeepgram` → `api.deepgramKey()`), then sets `state = 'active'`. If the user hits Stop (or the overlay unmounts) mid-await, `teardownMic/teardownDeepgram` run, but `beginMicPipeline` continues and:

1. `startMicCapture` resolves → assigns `micRef.current = handle` on a *stopped* session.
2. `openDeepgram` resolves → constructs a new `DeepgramService`, calls `service.connect()`, assigns `deepgramRef.current = service` — on a *stopped* session.

Net effect: a zombie mic stream + WebSocket that nobody owns; the next `start()` then sees `deepgramRef.current !== null` (well, actually it gets overwritten, so the *first* one leaks silently). The iOS analogue uses the `session === self.urlSession` guard pattern (`DeepgramService.swift:832`) to drop stale-session callbacks. The web code has no equivalent.

**File:line:** `web/src/lib/recording-context.tsx:193-215`
**Fix:** after each `await` in `start()`/`beginMicPipeline()`/`openDeepgram()`, guard with a captured session id (or a `cancelled` boolean snapshotted at call time) and tear down anything that was just created if the session has changed.

**3.3 `setState('error')` in `onerror` is clobbered by the immediately-following `onclose`.**
`deepgram-service.ts:86-100`: `ws.onerror` sets state to `'error'`. Browsers always follow a WebSocket `error` event with a `close` event. The `onclose` handler at `:91-100` sees `this.state !== 'error'` is false (it *is* `'error'`), so it correctly preserves the state — but it still calls `onError` again with `Deepgram WS closed (code=1006)` for any abnormal close. The caller (`recording-context.tsx` `onError` callback) only filters by `deepgramRef.current` truthiness, so the same underlying failure surfaces as two distinct error toasts/messages in quick succession.

**File:line:** `web/src/lib/recording/deepgram-service.ts:86-100`
**Fix:** set a flag when `onerror` fires and suppress the `onError` call in `onclose` if it's set; or drop the `onError` call in `onclose` entirely and rely on `onerror` to own the user-visible surface.

**3.4 KeepAlive fires even if `this.ws.bufferedAmount` is already huge.**
`startKeepAlive()` (`:237-250`) blindly queues another 16 KB (the 500 ms silence buffer) every 10 s. If the tab has been throttled (background), `bufferedAmount` can grow unboundedly and there's no back-pressure check. Admittedly rare on active foreground PWA use, but it also interacts with 3.2 — if a zombie WS keeps the timer alive, you leak 16 KB / 10 s until GC collects the closure (the `ws` and `this.ws` references keep the service alive indefinitely because `setInterval` retains `this`).

**File:line:** `web/src/lib/recording/deepgram-service.ts:239-249`
**Fix:** check `this.ws.bufferedAmount` and skip the keep-alive silence (or the whole tick) if it's above e.g. 32 KB; log so we notice.

**3.5 `onError` for `CloseStream` race is filtered on `deepgramRef.current` but the ref is nulled *before* `disconnect()` finishes.**
`recording-context.tsx` `teardownDeepgram()` (commit version at `:127-131`) does `deepgramRef.current?.disconnect(); deepgramRef.current = null;` synchronously. `disconnect()` schedules a 300 ms `setTimeout` to call `ws.close(1000)`. During that 300 ms window any server-side error that triggers `ws.onerror` → `onError` callback sees `deepgramRef.current === null` (because we just nulled it) and is *silenced* — which is what the author intended. But the same guard also silences genuine server errors that happen immediately after the user-initiated close, which is surprising. The comment at `:165-167` says "prevents a spurious red-flash when a normal CloseStream races with `stop()`" — the intent is right but the mechanism conflates "we're closing" with "there is no service"; a dedicated `closing` flag would be clearer and less fragile.

**File:line:** `web/src/lib/recording-context.tsx:161-170` (commit version)
**Fix:** introduce a `closingRef` / `isStoppingRef` boolean, set in `stop()` / `teardownDeepgram()`, read from the `onError` handler.

### P2

**3.6 Linear-interpolation resampler assumes `sourceSampleRate >= 16 000`.**
`resampleTo16k` (`:220-232`) computes `ratio = sourceSampleRate / 16000` and `outLen = floor(samples.length / ratio)`. If the mic opens at e.g. 8 kHz (rare but possible on Bluetooth headsets or low-bandwidth capture modes), `ratio < 1` → `outLen > samples.length` → `srcIdx` overshoots, the `hi = Math.min(lo + 1, samples.length - 1)` guard clamps to the last sample, but the final samples become a plateau of the last value. Either add a fast path / refuse to run upsampling (throw so caller knows) or do proper upsampling.

Also: this is a one-tap linear interpolator with no anti-alias filter. Adequate for speech at modest ratios (48 k → 16 k is 3:1, produces some aliasing but Deepgram handles it), but a comment acknowledging the trade-off would be worth adding.

**File:line:** `web/src/lib/recording/deepgram-service.ts:220-232`

**3.7 URL builder has no `keyterm` / keyword-boost support.**
iOS `buildURL` appends up to ~89 `keyterm` query items with 1800-char length check + selective boost suffix for top-tier keywords (`DeepgramService.swift:482-528`). Web URL is a plain static string. Keyterm prompting is the single biggest quality differentiator on Nova-3 for EICR vocabulary (RCDs, BS 7671, Zs/Ipf/EFLI, cable sizes). Deferring this is fine for 4c, but the working tree post-4e still doesn't add it — worth a TODO + a ticket.

**File:line:** `web/src/lib/recording/deepgram-service.ts:202-218`

**3.8 `Results` with `transcript === ''` is dropped entirely, even when `speech_final` or `is_final` is set.**
`deepgram-service.ts:275-276` short-circuits on empty transcripts. iOS does the same (`DeepgramService.swift:620`), but that means the empty-final-flush signal (Deepgram emits a final with an empty transcript on `UtteranceEnd` in some configurations) never reaches the Sonnet pipeline. Not actively wrong today, but worth flagging because Phase 4d's extraction WS may care.

**File:line:** `web/src/lib/recording/deepgram-service.ts:275-276`

**3.9 `speech_final` is not surfaced.**
iOS logs `speech_final` (`DeepgramService.swift:616-617, 643`) which distinguishes a true utterance-end final from a rolling interim-final. Web ignores the flag. Low-impact for 4c but plan to expose it as a third callback (`onSpeechFinal`) or on `onFinalTranscript` signature when Phase 4e SleepDetector needs it — the SleepManager's VAD heuristic in iOS leans on this.

**File:line:** `web/src/lib/recording/deepgram-service.ts:278-306`

**3.10 `api.deepgramKey` doesn't encode `sessionId` through the idempotent-retry path with backoff-multiplier.**
`api-client.ts` `request<T>` retries GETs up to 3× with exponential backoff. A token fetch that 401s (e.g. auth header not set yet, or backend token version was bumped) will retry 3× and then bubble — that's 2 × 500 ms = ~1 s delay before the user sees an error. Not a bug, but mic is opened *before* the key fetch in `beginMicPipeline`, so the red indicator appears ~1 s after the mic permission prompt — user-unfriendly sequencing. Consider fetching the key first, mic second.

**File:line:** `web/src/lib/recording-context.tsx:281-289` (commit version, `beginMicPipeline`).

**3.11 Sample-rate mismatch: mic opens at 16 kHz (per `mic-capture.ts:73`), but `openDeepgram(handle.sampleRate)` is called with whatever the mic handle reports. If the browser ignores the `{ ideal: 16000 }` constraint (Safari often does), the AudioContext will default to device rate (48 kHz) and the resampler kicks in every block. That's fine functionally — but the `WORKLET_URL` processor emits 128-sample blocks at *device* rate, so at 48 kHz each block is ~2.67 ms, tripling the number of `setInterval`-less `sendSamples` calls and the per-block WS send overhead. No actual bug, just worth benchmarking on iOS Safari PWA.

**File:line:** `web/src/lib/recording/mic-capture.ts:68-72` vs `web/src/lib/recording-context.tsx:297-298` (commit).

---

## 4. Security

- **No long-lived key in the browser.** `api.deepgramKey()` fetches a scoped token from `/api/deepgram-proxy`; the Deepgram account key stays on the backend. Matches iOS.
- **Subprotocol auth over TLS.** `wss://` + subprotocol header — not logged by browser network tools the way `?token=` query params are (no URL history leakage). Good.
- **No request body logging.** The `handleMessage` path never surfaces raw server messages to the DOM; all user-visible text comes from `transcript` strings. OK.
- **Session id is non-cryptographic.** `recording-context.tsx:189-192` uses `Date.now() + Math.random()` for the session id. Fine for correlation purposes — the backend should enforce its own uniqueness / auth-scoping — but if this id is ever used for anything security-sensitive (authorising the Sonnet WS, e.g.) a `crypto.randomUUID()` is preferable. Minor.
- **No rate limiting on `start()` loop.** A script or accidental double-click can invoke `start()` while `'error'` → `'error'` repeatedly. Each invocation fetches a fresh Deepgram token from the backend. Low impact today, but consider debouncing the Start button.
- **`onError` message forwarded verbatim to UI.** `recording-context.tsx:161-166` writes the error `.message` to `setErrorMessage`. Deepgram's `"Error"` message `json.message` arrives through `handleMessage` → `onError(new Error(msg))` → UI. If Deepgram ever returned HTML or a value containing user-controlled data, this would be rendered as *text* (React escapes it — safe from XSS) but might leak internal error detail. Fine; worth mentioning for completeness.

---

## 5. Performance

- **Per-block allocations.** `sendSamples` allocates a fresh `Int16Array` per block (`:114`). At 16 kHz / 128 samples that's one 256-byte allocation every ~8 ms = ~125/s ≈ 32 KB/s of GC pressure. Minor. At 48 kHz device rate (see 3.11) this doubles. Consider a reusable `Int16Array` scratch buffer held on the instance.
- **Per-block resample allocation.** `resampleTo16k` also allocates a fresh `Float32Array` per call. Same class of issue.
- **`transcript.slice` on every final.** `recording-context.tsx:146-157` always allocates a new array. Cap at 10 so always small — fine.
- **`setTranscript` triggers a full Provider re-render** of every consumer (currently `RecordingOverlay`, `TranscriptBar`). Not an issue today, but if more surfaces subscribe, split the context into "hot" (interim, micLevel, transcript) and "cold" (state, costUsd, actions) slices — otherwise every tick re-renders the entire tree.
- **`lastLevelPushRef` throttle to 60 Hz is good.** `beginMicPipeline` caps `setMicLevel` at 16 ms (`:290-294`). Well done.
- **`setInterval` at 10 Hz in `beginTick`.** 100 ms granularity for the elapsed + cost readout. Fine; matches iOS.
- **KeepAlive allocates a 16 KB buffer every 10 s** (`:244`). Fine.
- **No backpressure check on `ws.send`.** See P1 3.4.

---

## 6. Accessibility

- **Overlay `role="dialog" aria-modal aria-label="Recording session"`** — good. But the aria-label is static; when `state` changes to `'error'`, the label doesn't reflect the error.
- **`aria-live="polite"` region for questions** (`recording-overlay.tsx:152-157`) — good. But the *transcript* log itself has no `aria-live`, so screen-reader users won't hear incoming finals. Adding `aria-live="polite"` on the transcript container would let SR users follow along.
- **Interim partials change visually (italic grey) but there's no announcement.** Deliberate — SR users would be flooded — so intentional behaviour should be documented.
- **`dismissQuestion` button hit area is 24 × 24** (`:170-175`), below the 44 × 44 touch-target guidance (CLAUDE.md design rules). Fix: bump to `h-11 w-11` at least on mobile.
- **State pill is colour-only for differentiation.** `requesting-mic` / `active` / `dozing` / `sleeping` / `error` each get a different `colour`, but the text label ("Recording", "Paused", etc.) covers the cognitive meaning — OK.
- **Error message text uses `var(--color-status-failed)` on `var(--color-surface-1)` background.** Contrast should be verified against WCAG AA — not inspectable from the diff alone.
- **Focus ring on `HeroIconButton`** uses `focus-visible:outline-2 focus-visible:outline-white` — visible over the blue/green gradient. OK.
- **`<button>` on the transcript bar (`transcript-bar.tsx:29-34`) has `aria-label="Expand recording overlay"`** — good.

---

## 7. Code quality

**Positives:**
- Clear module-level doc on both files explaining what is in 4c and what is deferred to 4e — reads well six months from now.
- Comments explain *why*, not *what* (matches CLAUDE.md commit rules).
- No `any`s in the working-tree `deepgram-service.ts` — only `unknown` with typed narrowings at parse time.
- Callbacks passed in via a single `DeepgramCallbacks` object is the right shape — avoids ten-arg constructors and makes tests easy.
- `setState` method centralises state transitions and the `if (this.state === next) return;` short-circuit prevents duplicate `onStateChange` calls. Good.

**Nits:**
- `private state: DeepgramConnectionState = 'disconnected';` shadowed by public getter `connectionState` — fine but the naming asymmetry is minor. Prefer `private _state`.
- `Record<string, unknown>` casts in `handleMessage` (`:262-296`) are slightly brittle — a small Zod schema (or hand-rolled type-guard) would be more readable and would catch schema drift. Low priority.
- `switch (type)` falls through to `default:` with a comment rather than doing something useful like logging unknown types at debug level. iOS does this (`DeepgramService.swift:604-606` logs unknown msg types). Web quietly drops. Consider adding a DEV-only `console.debug`.
- `onError: () => {}` default could be avoided by using a typed `Required<DeepgramCallbacks>` or by providing no-op defaults inside the service.
- `deepgram-service.ts:42` comment "Tracked so the KeepAlive loop only fires during extended silence." is accurate but doesn't say *why* we need real audio vs silence — could link to iOS history note (`DeepgramService.swift:157-164`).
- `id: u_${Date.now()}_${prev.length + 1}` (`recording-context.tsx:151`): two rapid finals in the same millisecond with `prev.length` unchanged (because of React batching) could collide. Improbable, but `crypto.randomUUID()` is cheaper than debugging this later.
- `new WebSocket(url, ['token', apiKey])` — the `apiKey` is placed in a subprotocol header which is logged by some WebSocket inspectors (Safari Web Inspector shows it). Not a deployment concern but worth a comment that the value *is* visible to devs inspecting their own traffic.

---

## 8. Test coverage

**No test file was added for this phase.** `web/src/lib/recording/__tests__/` doesn't exist; no `deepgram-service.test.ts`, no `recording-context` behaviour test. The previous phases (4a, 4b) presumably didn't add tests either (this would be a broader debt, not 4c-specific), but given 4c introduces the first network boundary in the recording pipeline *and* the first stateful external service, a few unit tests would have high ROI:

Minimum viable test set (suggested):
1. **`DeepgramService.buildURL()` snapshot** — freeze the current 12-param URL so a future iOS / web divergence is caught in CI.
2. **`sendSamples` with various sourceSampleRates** — 16 k (no-op path), 48 k (3:1 downsample), 8 k (upsample — would fail today, see 3.6).
3. **`handleMessage` parser** — feed canned Deepgram frames (interim, final, SpeechStarted, UtteranceEnd, Error, Metadata) and assert callbacks fire correctly. `Results` with empty transcript, with missing `alternatives`, with missing `words`.
4. **State transitions** — `connect` → `onopen` → `connected`; `connect` then `close(1011)` → both `error` state set *and* `onError` fires.
5. **KeepAlive timing** — use `vi.useFakeTimers()` to assert: no ping within 8 s of last `sendSamples`; ping at 10 s of idle; both JSON + silence frames sent.
6. **`disconnect()` graceful-flush** — assert `CloseStream` JSON is sent, 300 ms later `ws.close(1000)` is called.
7. **`recording-context` smoke** — mock `DeepgramService`, assert `start()` → `active`, `stop()` → `idle`, and `onFinalTranscript` pushes onto transcript + clears interim.

No E2E / MSW test for `/api/deepgram-proxy` — OK for 4c, but please add one once the backend contract is stable (it's the single point of failure for P0 3.1).

---

## 9. Suggested fixes (numbered, file:line)

1. **P0** Verify token type vs. subprotocol — pick one:
   - a) `web/src/lib/recording/deepgram-service.ts:74` — change `['token', apiKey]` → `['bearer', apiKey]` if the proxy returns JWTs.
   - b) Document + assert that `/api/deepgram-proxy` returns a raw API key, *not* a JWT. Add a connection-succeeded smoke test in CI.
   - Update the `api.deepgramKey` response type in `web/src/lib/api-client.ts:124-127` to include the auth scheme.

2. **P1** Guard async paths in `start()` against being cancelled by `stop()`:
   - `web/src/lib/recording-context.tsx:193-215` — snapshot `sessionIdRef.current` at entry; bail after each `await` if it changed; tear down any mic/WS that the late awaits produced.

3. **P1** De-dupe `onerror` + `onclose` user-visible errors:
   - `web/src/lib/recording/deepgram-service.ts:86-100` — set `this.errorFired = true` in `onerror`; suppress the `onclose` `onError` call if set.

4. **P1** Back-pressure check in KeepAlive:
   - `web/src/lib/recording/deepgram-service.ts:239-249` — skip the silent-audio send when `this.ws.bufferedAmount > 32_000`.

5. **P1** Explicit `closing` flag:
   - `web/src/lib/recording-context.tsx:127-131` + `deepgram-service.ts:165-192` — add a `closing = true` on `disconnect()` entry; `onError` filters on that, not on `deepgramRef.current`.

6. **P2** Resampler sample-rate-up guard:
   - `web/src/lib/recording/deepgram-service.ts:220-232` — throw or log if `sourceSampleRate < 16000`.

7. **P2** Surface `speech_final` and empty-final frames:
   - `web/src/lib/recording/deepgram-service.ts:275-307` — drop the empty-transcript early return when `is_final || speech_final` is set, and pass the flag to a new optional `onSpeechFinal` callback (needed by Phase 4e).

8. **P2** Reusable scratch buffers:
   - `web/src/lib/recording/deepgram-service.ts:114-118` — hold an `Int16Array` scratch buffer sized to the latest block and reuse across calls.

9. **P2** Transcript `id` uniqueness:
   - `web/src/lib/recording-context.tsx:151` — use `crypto.randomUUID()` (with a fallback) instead of `Date.now()_length+1`.

10. **P2** `aria-live="polite"` on the transcript container:
    - `web/src/components/recording/recording-overlay.tsx:139-172` — allow screen-reader users to follow incoming finals.

11. **P2** Bump dismiss-question button touch target to 44×44 on mobile:
    - `web/src/components/recording/recording-overlay.tsx:170-176` — change `h-6 w-6` to `h-11 w-11` (or use CSS to extend the hit area beyond the icon).

12. **P2** Add the minimum-viable unit test set listed in §8 (1-6).

13. **P2** Token fetch sequencing in `beginMicPipeline`:
    - `web/src/lib/recording-context.tsx:281-289` — consider fetching the Deepgram key first, then opening the mic, so the user doesn't grant permission only to see an API failure 1 s later.

14. **Nice-to-have** `keyterm` prompting support:
    - `web/src/lib/recording/deepgram-service.ts:202-218` — port iOS's URL-length-aware keyterm append loop. Requires a shared vocabulary source (`KeywordBoostGenerator` equivalent) in `packages/shared-utils`. Track as a separate ticket, not blocking.

---

## 10. Verdict + top 3 priorities

**Verdict:** Ship-worthy as an incremental phase. Solid mirror of the iOS client at the protocol level; the deferred items (reconnect, pause-with-KeepAlive, ring-buffer, sonnet) are correctly scoped out. The P0 item below is the one thing I would not deploy to production without resolving.

**Top 3 priorities:**

1. **Confirm the auth scheme against the backend proxy (§3.1 / Fix 1).** If `/api/deepgram-proxy` returns a JWT from `/v1/auth/grant`, `['token', jwt]` will 401 at the WS upgrade — same pitfall iOS documented in `DeepgramService.swift:228-233`. Either switch to `['bearer', apiKey]` or prove the proxy returns a raw key. Add a smoke test.

2. **Guard the async stop-race in `start()` (§3.2 / Fix 2).** The current code can leak a mic stream + WebSocket if the user stops while `requesting-mic` is in flight. Snapshot `sessionIdRef`, bail on mismatch, tear down late-arrivals. iOS's `session === self.urlSession` guard is the canonical pattern — mirror it.

3. **Add a minimum unit-test set (§8 / Fix 12).** `buildURL` snapshot, `handleMessage` parser, and KeepAlive timing are cheap and would have caught both the auth-scheme ambiguity and (prospectively) any Deepgram params drift between web and iOS. This is the single biggest leverage point for the remaining recording-pipeline phases.

---

*Reviewed against working-tree context post-4d/4e to understand Phase 4c's intended evolution path; scoring and fix line-numbers reference the state at commit 9e93907 unless otherwise noted.*
