# Wave 3c Handoff — Deepgram WS Reconnect Tests

**Branch:** `wave-3c-deepgram-ws-tests` (off `web-rebuild`)
**Scope:** `FIX_PLAN.md §E E1` row `deepgram-service.ts` — three target cases: (a) single reconnect per close, (b) 16 kHz resample correctness, (c) KeepAlive gated on `bufferedAmount`.
**Status:** 13 tests passing + 2 `it.todo` placeholders documenting an unfixed product defect · full web suite 65 passed / 2 todo · `tsc --noEmit` clean · `npm run lint` clean (0 errors, 6 pre-existing warnings).

---

## What was done

Added `web/tests/deepgram-service.test.ts` — a single file covering the three FIX_PLAN cases against a real `WebSocket` instance driven by a fake server. The product code (`web/src/lib/recording/deepgram-service.ts`) is unchanged — no testability seams were introduced.

### Test file layout

| Group | Tests | Case |
|---|---|---|
| `single reconnect per close (errorEmitted guard)` | 4 | (a) |
| `16 kHz resample correctness` | 6 | (b) |
| `KeepAlive gated on bufferedAmount` | 2 (`it.todo`) | (c) — blocked; see below |
| `KeepAlive — current idle-based gating (regression guard)` | 3 | ancillary — protects the current idle gate so the `bufferedAmount` fix doesn't silently regress it |

### Case (a) — single reconnect per close

Exercises the private `errorEmitted` flag (deepgram-service.ts:56) that de-dupes the common Chromium/Safari double-fire of `onerror` then `onclose`. Four cases:

1. `server.error()` fires both handlers, `onError` callback called exactly once.
2. Clean close (code 1000) emits no error.
3. Abnormal close (code 1006) with no prior error event still emits one error.
4. `connect()` resets the guard — a new connection can emit a new error.

Relevant product assertion: the upstream `recording-context.tsx` reconnect path is driven by `onError`, so "one `onError` callback = one reconnect attempt." The test doesn't assert the reconnect directly (that lives in `recording-context.tsx` and is a separate integration surface); it asserts the contract the reconnect relies on.

### Case (b) — 16 kHz resample correctness

`resampleTo16k` is private. The tests drive it through the public `sendSamples()` surface and inspect the Int16 bytes that arrive at the fake WS. Six cases:

| Case | Input rate | Tolerance | What it proves |
|---|---|---|---|
| 32 kHz → 16 kHz downsample | 32000 Hz, 8 samples | ±1 LSB | Integer-ratio decimation picks every Nth sample |
| 48 kHz → 16 kHz ramp | 48000 Hz, 12-sample ramp | ±1 LSB | Integer ratio 3 with linear-interp formula collapses to `lo` branch |
| 44.1 kHz → 16 kHz | 44100 Hz, 10 samples | ±1 LSB | Fractional ratio (2.75625) exercises full linear-interp math; test re-computes expected via the same formula |
| 16 kHz passthrough | 16000 Hz, 5 samples | ±1 LSB | Skips the resample path entirely |
| Clamp outside [-1, 1] | 16000 Hz, 5 samples | exact | Saturates to Int16 min/max before Math.round |
| Zero-length buffer | 16000 Hz, 0 samples | exact | No WS frame sent |

**Tolerance rationale** (documented in the file header): `Math.round` in JavaScript rounds half-integers asymmetrically — `Math.round(16383.5) === 16384` but `Math.round(-16383.5) === -16383`. Any sample whose float counterpart crosses a half-integer boundary is ±1 LSB from a "mathematically symmetric" expected value. Samples that don't land on halves are asserted with exact equality.

### Case (c) — KeepAlive gated on bufferedAmount

**Kept as `it.todo` placeholders. This is a genuine unfixed product defect + a mock-socket gap.** See "Product bugs surfaced but not fixed" below. The placeholder descriptions cross-reference this handoff so the Wave 4 (or later) engineer who fixes the product defect also knows where to find the test shape.

### Ancillary — KeepAlive current idle-gating regression guard

Three tests that pin down the behaviour the `bufferedAmount` fix must preserve:

1. First KeepAlive fires at t=10 s with no audio (idle = Infinity, ≥8 s → send JSON control + 500 ms silent PCM = 2 frames).
2. KeepAlive suppressed when audio flowed within last 8 s; fires again once idle climbs back past 8 s.
3. `disconnect()` clears the interval — no frames arrive after disconnect even 30 s later.

These weren't in the FIX_PLAN target list but are low-cost insurance against the inevitable refactor of `startKeepAlive()` when `bufferedAmount` lands.

---

## WS mock library decision

**Chosen:** `jest-websocket-mock@^2.5.0` (pulls in `mock-socket@^9.3.0` transitively).

**Rationale:**

1. **Vitest 4 compatibility verified.** Smoke-tested during Wave 3c spike (`vitest@4.1.4` + `jsdom@29.0.2`) — a handshake + send + receive cycle passes with no modification. The "jest-" prefix is historical (the library just re-exports mock-socket with some matcher helpers); nothing inside the runtime assumes jest globals.
2. **`mock-socket` installs a drop-in global `WebSocket`.** The product code (`deepgram-service.ts:85`) calls `new WebSocket(url, ['token', apiKey])` without any DI — a fake server that intercepts that global is the only way to test it without adding a testability seam.
3. **No hand-rolled alternative was prototyped.** Had the smoke test failed, the fallback (a hand-rolled `class FakeWebSocket` covering `readyState`, `send`, `close`, `onopen/onmessage/onerror/onclose`, and a queued message inbox) would have been roughly 60–80 lines — on the edge of the 100-line threshold in the brief. `jest-websocket-mock` landing cleanly removed that decision from the critical path.
4. **Matches the Wave 2b handoff recommendation** (reviews/WAVE_2B_HANDOFF.md line 121) so the decision is consistent with the earlier fix plan.

### Known limitation of the chosen library

`mock-socket`'s `send` implementation hard-codes `bufferedAmount` to `0` and has a literal `// TODO: handle bufferedAmount` in its source (`node_modules/mock-socket/dist/mock-socket.es.mjs:1586`). This is the primary blocker for writing case (c) as a real assertion — see below.

### Fake-timer ergonomics note

`mock-socket` dispatches `onopen` via a `setTimeout(..., 4)` (its `delay()` helper), and `ws.send()` delivers to the server queue the same way. Tests that install `vi.useFakeTimers({ toFake: [..., 'setTimeout', 'performance'] })` BEFORE `connect()` must advance the virtual clock past those delays (`await vi.advanceTimersByTimeAsync(10)`) before `await server.connected` resolves, and must drain audio-frame deliveries (`await vi.advanceTimersByTimeAsync(10)`) before asserting on `server.messages`. This is documented in the test file header and at each fake-timer install site.

---

## Testability seams added to product code

**None.** `web/src/lib/recording/deepgram-service.ts` is byte-identical to `web-rebuild`. `mock-socket`'s global-WebSocket hijack means the service's real `new WebSocket(url, subprotocols)` call transparently reaches the fake server.

---

## Verification

```
$ cd web && ./node_modules/.bin/vitest run
 Test Files  7 passed (7)
      Tests  65 passed | 2 todo (67)

$ ../node_modules/.bin/tsc --noEmit
# clean

$ npm run lint
✖ 6 problems (0 errors, 6 warnings)
# 6 pre-existing warnings (same surface as Wave 2b baseline):
#   - 5× react-hooks/exhaustive-deps on job/[id]/{design,extent,inspection,installation,supply}/page.tsx
#   - 1× unused _certificateType in components/job/job-tab-nav.tsx
```

Test count breakdown:
- Wave 2a: 32 tests
- Wave 2b: +20 adapter tests → 52 tests
- Wave 3c: +13 deepgram tests (+ 2 `it.todo`) → **65 passing + 2 todo**

---

## Product bugs surfaced but not fixed

### Unfixed — `KeepAlive` is not gated on `ws.bufferedAmount`

**Surface:** `web/src/lib/recording/deepgram-service.ts:254-267` (`startKeepAlive`).

**Current behaviour:** the interval body checks `this.ws && this.state === 'connected'` and the idle-ms threshold (≥ 8000 ms). It does NOT read `this.ws.bufferedAmount`. So if the socket is already back-pressured (slow network, large audio payloads queued), a KeepAlive + 500 ms silent PCM frame still gets enqueued on top.

**Expected behaviour (per FIX_PLAN §C Phase 4b P1, line 144):** when `ws.bufferedAmount > 0` (or above some threshold), skip the KeepAlive for this tick. The next tick evaluates fresh — once the buffer drains to 0, the scheduled KeepAlive fires.

**Why Wave 3c did not fix it:** the task brief explicitly says "TEST-ONLY — do not change `deepgram-service.ts` unless a test reveals a bug, in which case STOP and document rather than fix." Two `it.todo` placeholders (`tests/deepgram-service.test.ts:281-287`) mark the missing coverage with cross-refs back to this handoff and the FIX_PLAN line.

**Second blocker for future fix verification:** `mock-socket` doesn't model `bufferedAmount`. Even after the product gains the gate, a real test needs one of:

- A hand-rolled fake WS that exposes a mutable `bufferedAmount` property. ~40 lines in the test file; acceptable.
- A patch to mock-socket (or a fork) that lets tests drive `bufferedAmount` externally. Upstream PR or workspace-level shim.
- A testability seam on `DeepgramService` that injects a `getBufferedAmount()` hook. Least invasive to the test harness but requires touching production.

Recommended path (for the Wave that fixes the product defect): land the product gate, then write the test against a minimal hand-rolled fake WS (extending `EventTarget`) injected via a constructor-level seam. The seam cost is low because the product will already be touched to read `bufferedAmount`.

### Not surfaced (out of scope for E1 row)

No other defects uncovered. The `errorEmitted` guard behaves exactly as documented; the resample math matches the linear-interpolation formula exactly (within `Math.round` asymmetry); the KeepAlive idle-gate fires on schedule.

---

## Remaining gaps

- **Case (c)** — see above. Escalated as `it.todo` + this handoff; not in-scope to fix per Wave 3c brief.
- **No integration-level reconnect assertion.** Wave 3c tests the `onError`-dedupe contract inside `DeepgramService`. The actual reconnect loop lives in `recording-context.tsx` and is E1 row `sonnet-session.ts` / E2 integration territory — tracked in FIX_PLAN but not in this wave.
- **Observability.** No console-error / telemetry assertion on the `catch` blocks inside `sendSamples` / `sendInt16PCM` / `startKeepAlive`. Currently they silently swallow. Would pair naturally with the Wave 2b "observability sink for `parseOrWarn` drifts" gap — when that metric surface lands, add a counter on these try-swallow paths.
- **Test file is ~440 lines.** Within the vitest test budget but on the longer side. If Wave 4 adds more deepgram coverage (e.g. the `handleMessage` / Results parsing path, `sendInt16PCM` replay path, `pause`/`resume`), split into `deepgram-service.connection.test.ts` / `deepgram-service.audio.test.ts` / `deepgram-service.keepalive.test.ts`.

---

## File inventory

**Added:**
- `web/tests/deepgram-service.test.ts` (440 lines, 15 tests = 13 passing + 2 `it.todo`)

**Modified:**
- `web/package.json` — added `jest-websocket-mock: ^2.5.0` to `devDependencies`.
- `web/package-lock.json` — regenerated for the new dep (650 packages added, transitive).

**Unchanged:**
- `web/src/lib/recording/deepgram-service.ts` — zero lines modified.
- `web/tests/setup.ts` — no changes; `mock-socket` installs its own global `WebSocket` without setup-file help.
- `web/vitest.config.ts` — no changes.

---

## Recommended next wave

Per FIX_PLAN §F, Wave 3 (recording hardening) is the planned next unit. The remaining row of E1 that would pair naturally with this file:

- **`sonnet-session.ts` tests** (session_resume on reconnect, JWT-only auth). Same fake-WS scaffold, different product surface.
- **`apply-extraction.ts` / `apply-document-extraction.ts` tests** (E1 rows — no WS involved, just merge helpers). Low-risk parallelisable work.

When the `bufferedAmount` product fix lands (likely bundled with Wave 1 P1 follow-ups), this file is the drop-in location for the two `it.todo` → `it` promotions. The suite comment and file header spell out what the fix needs.

---

Deepgram WS test harness stood up with zero product-code change. 13 tests covering cases (a) and (b) as specified, plus 3 ancillary KeepAlive regression guards. Case (c) documented as unfixed product defect — fix + test belong in a dedicated wave that also decides the `bufferedAmount` mock-socket workaround.
