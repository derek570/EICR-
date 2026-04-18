# Wave 3 Functional Handoff — Recording pipeline client-side hardening

**Branch:** `web-rebuild`
**Merges:**
- `wave-3f-recording-client-hardening` — D3 + 4b + 4e (product code + tests)
- `wave-3h-playwright-record-e2e` — Playwright harness + record flow spec
- **Not merged:** Wave 3g (4c — Sonnet `session_resume` on reconnect). **Deferred** — requires backend protocol change. See §3 below.

**Scope delta vs FIX_PLAN §F Wave 3:** delivered the three client-side items that don't touch backend contracts. The Sonnet `session_resume` item (4c) has been promoted into its own mini-wave **4c.5** because it's a cross-stack design that doesn't fit the single-agent-per-sub-item pattern.

**Status:** 73/73 (0 `it.todo`) · `tsc --noEmit` clean · `npm run lint` 0 errors / 6 pre-existing warnings · Playwright record flow green on chromium.

---

## 1. What was done

### D3 — sessionId guards + explicit status state machine (`e18565c`)

- Added synchronous `statusRef` mirror inside a wrapped `setState` on `RecordingProvider` so async handlers can check current status without a stale React closure.
- Token-based sessionId captured at `start()`; every `await`-reentry in `start / stop / pause / resume / handleWake / openDeepgram` re-checks the token is still current and bails otherwise.
- Public `RecordingState` enum unchanged — no consumer churn.
- Double-tap Start is now a no-op. `stop()` → `start()` across a slow mic prompt no longer leaks pipelines.

### 4b — KeepAlive gated on `ws.bufferedAmount` + close-code logging (`c3adde2`)

- `DeepgramService.startKeepAlive()` now skips ticks when `ws.bufferedAmount > 0`. Next tick tries again.
- `onclose` logs `[deepgram] close code=<n> reason="<r>" reconnect=<bool>` on every close.
- **Constructor-level WS factory seam** added:
  ```ts
  export type WebSocketFactory = (url: string, protocols?: string[]) => WebSocket;
  constructor(callbacks: DeepgramCallbacks, wsFactory?: WebSocketFactory)
  ```
  Default preserves `new WebSocket(url, protocols)`; tests opt in.
- Promoted both `it.todo` stubs in `web/tests/deepgram-service.test.ts` to real passing tests using a local `FakeBufferedWs` (EventTarget subclass with mutable `bufferedAmount`). `mock-socket`'s hardcoded `bufferedAmount === 0` sidestepped without touching product semantics.

### 4e — `getUserMedia` `{ ideal: value }` lock-in (`d799c84`)

- Added `web/tests/mic-capture.test.ts` asserting `sampleRate` and `channelCount` are wrapped in `{ ideal: … }` per `~/.claude/rules/mistakes.md`.
- Product code was already correct — the target site had been refactored out of `recording-context.tsx` into `mic-capture.ts` in a prior phase. The test locks it in so it can't regress.

### Playwright harness + record flow spec (`0def74f`, `504224a`, `f72edf9`, `1ae4a4b`)

- `web/playwright.config.ts`: chromium + webkit projects, `webServer` runs `npm run dev --workspace=web` on port 3001, list reporter, 0 retries local / 2 CI.
- `web/tests-e2e/smoke.spec.ts` (harness sanity — login renders, both projects).
- `web/tests-e2e/record.spec.ts` (chromium only):
  - **Start → Pause → Resume → Stop**: FAB mic click → overlay visible → `Recording` pill → Pause → `Paused` pill → Resume → `Recording` pill → Stop → overlay hidden → no error toast.
  - **ATHS pulse respects `prefers-reduced-motion`**: fresh context with `reducedMotion: 'reduce'` → `matchMedia` asserts true inside the app → start/stop completes cleanly.
  - **Focus trap (`fixme`)**: 12-Tab cycle must stay inside the dialog. Marked `fixme` — the overlay is a raw `role="dialog"` div today; the assertion flips green after Wave 4 D5 (Radix Dialog sweep).
- `web/tests-e2e/fixtures/deepgram-ws-stub.ts`: browser-side WebSocket swap via `context.addInitScript` BEFORE any product code evaluates. Fake accepts the Deepgram subprotocol, emits one interim + one final `Results` on first audio frame, handles `CloseStream`, falls through to native `WebSocket` for non-stubbed hosts.
- `web/tests-e2e/fixtures/auth.ts`: JWT mint + localStorage seed + HTTP route stubs for `/api/jobs/…`, `/api/sonnet-key`, etc. All fixture bodies pass through adapter schemas from `web/src/lib/adapters/` so they can't drift from wire format.
- `npm run e2e` script added.
- **WebKit caveat:** headless Safari cannot fake a mic stream (`grantPermissions` rejects `microphone`; no Playwright launch-flag equivalent). Record flow specs are chromium-only; documented in `WAVE_3H_HANDOFF.md`.
- **Zero product-code changes, zero `data-testid` additions.** Every assertion resolves via `getByRole` / `getByLabel` against the existing a11y contract.

---

## 2. Why this approach (meta)

**D3 state machine over ref mirror, not a full reducer rewrite.** The existing provider has ~20 call sites across the recording UI; a reducer-based rewrite would have inflated the PR and churned unrelated types. A `statusRef` that mirrors the same setState is a surgical fix: it gives async handlers a synchronous read of current status without changing the public surface. The sessionId token is the guardrail that makes the ref safe against interleaved calls.

**4b WS seam over hand-rolled fake WS.** The hand-rolled alternative (~60–80 lines of EventTarget scaffolding + buffered-amount simulation) would have duplicated `mock-socket`'s work for one property. A one-arg constructor injection is the minimum seam that makes the test observable, and the default path preserves byte-for-byte behaviour. This is the shape 3c's handoff recommended.

**4e lock-in test, not a product-code edit.** The grep showed the product code was already compliant on a different file from the FIX_PLAN target. Writing a lock-in test prevents a future refactor from losing the `{ ideal }` wrapper — which is cheaper insurance than trying to prove "no regression happened" after the fact.

**Playwright WS stub via `addInitScript`, not `routeWebSocket`.** Playwright's `page.routeWebSocket` can intercept traffic but can't perfectly fake Deepgram's subprotocol + framing. A page-context constructor swap is cruder but more faithful: the app code runs unchanged against a JS object that emits the right events.

---

## 3. What was deferred and why

### Wave 4c — Sonnet `session_resume` on reconnect → **promoted to Wave 4c.5** (cross-stack)

**Discovered:** `web/src/lib/recording/sonnet-session.ts` has **no reconnect pathway at all**. It opens one WebSocket; on close, the `onclose` handler nulls the socket and fires an `onError` callback. There is no attempt counter, no retry timer, no reconnect loop anywhere in the web client. The subagent correctly stopped on its `no reconnect pathway present` guard.

**Why it can't land in a single client-side wave:**

1. The server-assigned session identifier is not currently surfaced to the client. `session_ack` (the first frame the server sends) carries `status` only — see `src/extraction/sonnet-stream.js`. To resume, the server needs to mint a resumable session ID and return it in `session_ack`.
2. The backend needs a `session_resume` handshake contract: when the client sends a resume frame with a valid session ID, the server must rehydrate the multi-turn Sonnet context rather than opening a fresh conversation. Today's server code opens fresh every time.
3. Neither of these is a single-file client change.

**Recommended Wave 4c.5 split (two coordinated agents):**

- **Agent A (backend):** add `sessionId` to the `session_ack` payload; implement the `session_resume` message handler in `src/extraction/sonnet-stream.js`; gate-keep with a 5-minute TTL on rehydratable sessions; unit tests on the session-store side.
- **Agent B (client):** introduce a reconnect state machine on `SonnetSession` (attempts counter, exponential backoff with jitter, terminal-failure surfaces back to `RecordingProvider`); capture `sessionId` from `session_ack`; send `session_resume` frame on reconnect; match Deepgram's close-code log format. Unit tests using `jest-websocket-mock`.

Agent A must ship and deploy before Agent B merges, or feature-flag the client-side resume and enable post-deploy. `Wave 3 Functional` did not delay landing the three client-side fixes waiting for this.

---

## 4. Verification (merged branch)

```
$ ./node_modules/.bin/vitest run
 Test Files  9 passed (9)
      Tests  73 passed (73)    # up from 70 pass + 2 todo; todos promoted

$ ./node_modules/.bin/tsc --noEmit -p web/tsconfig.json
# clean

$ cd web && npm run lint
# ✖ 6 problems (0 errors, 6 warnings)  — unchanged since Wave 2a

$ cd web && npm run e2e
# ✓  chromium  smoke.spec.ts       (0.9s)
# ✓  webkit    smoke.spec.ts       (0.9s)
# ✓  chromium  record.spec.ts × 2  (2.7s)
# 4 skipped (3 webkit record-flow + 1 chromium .fixme on focus-trap)
# 4 passed
```

Test surface growth:

| Wave | Count |
|---|---|
| 1 (kill list) | 32 |
| 2a (D6 harness + D12) | 32 |
| 2b (D2 adapters) | 52 |
| 3 test slice (3a/3b/3c) | 70 + 2 todo |
| **3 functional (3f/3h)** | **73 + 4 Playwright** |

---

## 5. iOS parity flags (do NOT change iOS in this wave)

Two items flagged by the 3f agent for a later iOS-side commit:

1. **iOS `DeepgramService.swift` KeepAlive** should gain an equivalent outgoing-buffer gate. Apple doesn't expose `bufferedAmount` directly on `URLSessionWebSocketTask` — the completion handlers on `send` can be used as a proxy (queue length inferred). Out of scope here; belongs in the iOS repo.
2. **iOS close-code log format** should match the new `[deepgram] code=… reason=… reconnect=…` string for cross-stream grep during incidents.

No Deepgram config keys (`utterance_end_ms`, `vad_events`, `endpointing`, model) were changed in this wave — parity intact.

---

## 6. Remaining gaps (genuinely deferred)

- **Wave 4c.5** (Sonnet session_resume) — scoped in §3 above; needs its own brief.
- **Focus-trap spec flipping green** — blocked on Wave 4 D5 (Radix Dialog sweep).
- **WebKit record-flow E2E** — Playwright headless can't fake a mic. Options: (a) run webkit record flow on real Safari via `playwright-webkit` with a prerecorded media file served via `about:blank` iframe, or (b) rely on chromium + manual iOS Safari QA for the WebKit path. Defer to Phase 8 iOS companion smoke.
- **Playwright in pre-push hook** — Q10 defers to Wave 5 / Phase 8 gate tightening. Expensive; local dev feedback loop stays vitest-only for now.
- **3f's D3 did not add an RTL hook test** (React-19 hoisting issue; see WAVE_3A_HANDOFF.md `mountHook` notes). Covered indirectly by the Playwright record flow.

---

## 7. File inventory (Wave 3 Functional aggregate)

**Added:**
- `web/tests/mic-capture.test.ts`
- `web/playwright.config.ts`
- `web/tests-e2e/smoke.spec.ts`
- `web/tests-e2e/record.spec.ts`
- `web/tests-e2e/fixtures/auth.ts`
- `web/tests-e2e/fixtures/deepgram-ws-stub.ts`
- `web/reviews/WAVE_3F_HANDOFF.md`
- `web/reviews/WAVE_3H_HANDOFF.md`
- `web/reviews/WAVE_3_FUNCTIONAL_HANDOFF.md` (this doc)

**Modified:**
- `web/src/lib/recording-context.tsx` — statusRef + sessionId token guards.
- `web/src/lib/recording/deepgram-service.ts` — bufferedAmount gate + close-code log + WS factory seam.
- `web/tests/deepgram-service.test.ts` — 2 `it.todo` → 2 real tests.
- `web/package.json` — `@playwright/test` devDep + `e2e` script.
- `web/.gitignore` — Playwright artifacts.
- `package-lock.json` — regenerated.

---

## 8. Recommended next wave

Per `WEB_REBUILD_COMPLETION.md` §2, next is **Wave 4 (RBAC + admin UX + modal a11y)**. Three parallel subagent scopes:
- **D4** — JWT `company_role` + middleware admin matcher + signature verify
- **D5** — Radix Dialog sweep across 6 modal sites; replace `window.confirm`. **Flips the 3h `.fixme` focus-trap spec to green.**
- **6c** — admin-user edit (editable company_id/company_role) + new `/api/admin/users/:id` backend endpoint + 6b settings key fix folded in

The Wave 4c.5 Sonnet reconnect work can run **in parallel with Wave 4** since it's a distinct code path (recording vs admin). Two options:
- Run Wave 4c.5 as a fourth parallel agent in the Wave 4 batch.
- Defer Wave 4c.5 to after Wave 4 ships.

Recommend the former — the parallel pattern was validated in Wave 3 and the two surfaces don't touch.

---

Wave 3 Functional landed on `web-rebuild`. Wave 4 + Wave 4c.5 is the next unit. `WEB_REBUILD_COMPLETION.md` updated to reflect the new state (see §2.1 "Wave 4c.5" row and §5 gate 2 revised).
