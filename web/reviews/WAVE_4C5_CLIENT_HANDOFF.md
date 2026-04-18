# Wave 4c.5 Client Handoff — Sonnet reconnect + `session_resume`

**Branch:** `wave-4c5-sonnet-resume-client` (off `web-rebuild`)
**Scope:** `web/reviews/WEB_REBUILD_COMPLETION.md` §2.1b — client half of the cross-stack Sonnet reconnect work. Ships behind a feature flag so deploy order with the parallel backend agent doesn't matter.
**Status:** 4 commits · 91 vitest (73 baseline + 18 new in `sonnet-session.test.ts`) · `tsc --noEmit` clean · `npm run lint` holds at 6 pre-existing warnings (0 new).

| Commit | SHA | Scope |
|---|---|---|
| A | `3d2e76c` | Capture `sessionId` from `session_ack` + surface via `onSessionAck` |
| B | `fa307f5` | Flag-gated reconnect state machine (exponential backoff + jitter, 5-attempt ceiling) |
| C | `4f4254c` | `session_resume` frame with captured id on every reconnect (falls back to `session_start` when no id) |
| D | `6a47bef` | Close-code log parity with Deepgram (`[sonnet] close code=… reason="…" reconnect=… attempt=…`) |

---

## Feature flag

### Name

```
NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED
```

Read at call time inside `SonnetSession.isReconnectEnabled()` (exported from `web/src/lib/recording/sonnet-session.ts`).

### Default

**OFF.** Any value other than `'true'` or `'1'` keeps the pre-Wave-4c.5 behaviour: one WS open, on close fire a recoverable `onError`, no retry.

### Production flip procedure (post-backend-deploy)

1. Verify the backend side of Wave 4c.5 is live (`src/extraction/sonnet-stream.js` emits `sessionId` on `session_ack` and handles incoming `session_resume` frames with a 5-minute TTL).
2. Add the env var to the web ECS task definition:
   ```
   NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED=true
   ```
   `NEXT_PUBLIC_*` is inlined at build time by Next.js, so the flip requires a rebuild. Trigger via GitHub Actions push to `main` once the task-def env is updated, or via `./deploy.sh` for a local quick-deploy.
3. Watch `aws logs tail /ecs/eicr/eicr-frontend --since 10m --filter-pattern "[sonnet]"` for close-code log lines; the new format is grep-compatible with `[deepgram]` so the existing reconnect-storm dashboard picks both up.
4. Rollback = remove the env var and redeploy. State machine gates cleanly back to "one open, error on close".

### Test hook

`globalThis.__RECONNECT_FLAG` wins over the env var. Vitest suites set this in a `beforeEach` to toggle per-test without Next.js's build-time env inlining getting in the way.

---

## What was done

### Commit A — sessionId capture

- New private fields on `SonnetSession`: `sessionId: string | null`, `sessionStatus: 'new' | 'resumed' | null`.
- `handleMessage` on `case 'session_ack'` now:
  - accepts optional `sessionId` string from the payload and stores it (defensive: requires `typeof === 'string' && length > 0`);
  - narrows `status` to `'new' | 'resumed'` before storing;
  - forwards the id to `onSessionAck` as an optional second argument.
- `SonnetSessionCallbacks.onSessionAck` signature widened from `(status: string) => void` to `(status: string, sessionId?: string) => void`. No current caller wires this callback, so no call-site migration needed.

### Commit B — reconnect state machine (flag-gated)

- Feature-flag resolver `isReconnectEnabled()` exported at module scope. Reads `NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED` at call time + honours `globalThis.__RECONNECT_FLAG` for tests.
- Constants:
  - `RECONNECT_BASE_MS = 500`
  - `RECONNECT_CAP_MS = 10_000`
  - `RECONNECT_MAX_ATTEMPTS = 5`
- `SonnetSession.computeBackoffDelay(attempt, rand?)` — `static`. Formula:
  ```
  delay = max(0, floor(min(base * 2^(attempt-1), cap) * rand()))
  ```
  AWS "full jitter" variant. Non-negative by construction, never exceeds the cap. `rand` injectable for unit tests.
- `connect()` refactored to seed the state machine (`shouldReconnect=true`, `reconnectAttempts=0`, `hasConnectedOnce=false`) and call new `openSocket()`.
- `openSocket()` holds the WS creation + handler wiring. Reconnect timer re-enters this (not `connect()`) so the latch and counter aren't clobbered.
- `onopen` resets `reconnectAttempts = 0` on any successful open (clean open resets; clean close does not — a close is intentional, an open proves the pipe works).
- `onclose` classifier:
  - clean = `code === 1000 || code === 1005 || !shouldReconnect` → never reconnect
  - flag OFF + non-clean → fire recoverable `onError` (pre-4c.5 behaviour)
  - flag ON + non-clean + attempts < max → `scheduleReconnect()`
  - flag ON + non-clean + attempts >= max → fire terminal non-recoverable `onError`
- `disconnect()` latches `shouldReconnect = false` and clears the pending timer BEFORE the existing 300ms grace close path, so an in-flight reconnect can't resurrect a user-initiated stop.

### Commit C — `session_resume` on reconnect

- `onopen` branches on `hasConnectedOnce && sessionId != null`:
  - true → send `{ type: 'session_resume', sessionId }` as the FIRST frame (before any preConnectQueue flush).
  - false → send the existing `session_start` frame (first open or legacy backend without an id).
- `session_ack` handler now detects TTL expiry: if the previous status was `'resumed'` and the current ack's status is `'new'`, fire a recoverable `onError` warning (`"Sonnet session context expired — continuing with fresh session"`). The session keeps going; the UI can choose whether to flag the gap.
- Wire-protocol compatible with the existing public `resume()` method: that sends `{ type: 'session_resume' }` (no `sessionId`) for pause/resume, whereas reconnect sends `{ type: 'session_resume', sessionId }`. Backend distinguishes by presence of the field.

### Commit D — close-code logging

- Single `console.info` line in `onclose`:
  ```
  [sonnet] close code=<n> reason="<r>" reconnect=<bool> attempt=<i>
  ```
- `reason` uses `JSON.stringify(event.reason ?? '')` so embedded quotes/newlines stay on one line (same trick as Deepgram).
- `reconnect=<bool>` is the state machine's actual decision (flag ON + dirty + under ceiling).
- `attempt=<i>` is the count that just failed — 0 for the initial open, 1..N for the Nth reconnect's close. Matches Deepgram's convention.

---

## Reconnect backoff formula

```
delay(attempt) = floor(min(500 * 2^(attempt-1), 10_000) * rand())
```

- `attempt` is 1-based (first reconnect = 1, fifth = 5).
- `rand()` is `Math.random()` in production; tests inject deterministic values.
- Full jitter: the actual delay is uniformly distributed in `[0, min(exp, cap)]`. That's the AWS pattern — strictly non-negative and decorrelated across instances.
- Cap reached at attempt 5: `500 * 2^4 = 8000` ms (still under cap). Attempt 6 would be 16 000 ms → capped at 10 000 ms (but 6 never fires because max = 5).

### Max-attempt exhaustion

After 5 failed reconnect attempts (`reconnectAttempts = 5` in `scheduleReconnect`), the 6th close classifies as exhausted and fires:

```ts
onError(new Error(`Sonnet reconnect failed after 5 attempts (last code=${event.code})`), false)
```

Non-recoverable (second arg `false`) so the UI can flip into the error overlay.

---

## Tests

`web/tests/sonnet-session.test.ts` — 18 tests across 6 describe blocks:

| Block | Count | Coverage |
|---|---|---|
| `session_ack handling (Commit A)` | 3 | captures id / undefined when server omits / retains across acks |
| `reconnect flag OFF (default)` | 2 | dirty close → one recoverable error, no retry / clean close is silent |
| `reconnect flag ON` | 4 | clean close no retry / dirty → reaches new server / counter resets on clean open / terminal error after 5 failed opens (stub `window.WebSocket`) |
| `session_resume on reconnect (Commit C)` | 4 | first open sends start / reconnect sends resume with captured id / fallback to start when no id / TTL expiry warning |
| `close-code logging (Commit D)` | 3 | format shape / `reconnect=true` on flag-ON dirty / `reconnect=false` on clean |
| `backoff math` | 2 | non-negative + within cap for all jitter seeds / upper-bound monotonicity + cap at attempt 6 |

### Test counts per flag state

- **Flag OFF** — 2 tests + all 3 Commit A session_ack tests + all 3 Commit D log tests + 2 backoff-math tests = **10 tests** exercise the flag-OFF path.
- **Flag ON** — 4 reconnect state-machine tests + 4 session_resume tests = **8 tests** exercise the flag-ON path.

### Gate output (latest run)

```
$ ./node_modules/.bin/vitest run
 Test Files  10 passed (10)
      Tests  91 passed (91)

$ ../node_modules/.bin/tsc --noEmit
# clean

$ npm run lint --workspace=web
✖ 6 problems (0 errors, 6 warnings)
  # Same 6 pre-existing warnings as Wave 3f baseline:
  #   5× react-hooks/exhaustive-deps on job/[id]/{design,extent,inspection,installation,supply}/page.tsx
  #   1× unused _certificateType in components/job/job-tab-nav.tsx
```

---

## Known footguns + deliberate limits

- **Test stability.** The "terminates after max attempts" test stubs `window.WebSocket` with a class whose constructor schedules an immediate dirty close on microtask — the only way to drive 5 failed reconnects without an intervening onopen resetting the counter. Keep this stub scoped to the single test; don't promote it to module-level.
- **Mock-socket + real timers.** Attempted fake-timer flows with `jest-websocket-mock` deadlock on microtask interleaving. We use real timers + `Math.random = () => 0` so the backoff collapses to ~0ms. Observed one-in-eight flakiness on one test at an earlier iteration; the current shape (reading close logs rather than driving long cycle chains) passed 8+ runs in a row.
- **`recording-context.tsx` is not touched.** The consumer still calls `openSonnet()` once; the state machine is entirely internal to `SonnetSession`. No prop drilling of reconnect state. If the UI later wants to show a "reconnecting…" chip during flag-ON retry cycles, surface it via an existing callback — don't add a new one without grepping for `onStateChange` first.
- **Backend coordination.** Client is safe to deploy with flag OFF before backend is ready. Flipping the flag before backend advertises `sessionId` is harmless — `hasConnectedOnce && sessionId != null` collapses to false, so reconnect just re-runs `session_start` (pre-4c.5 behaviour restart-from-scratch). Flipping the flag after backend is ready enables rehydration.

---

## File inventory

**Added:**

- `web/tests/sonnet-session.test.ts` — 18 tests across 6 describe blocks
- `web/reviews/WAVE_4C5_CLIENT_HANDOFF.md` — this file

**Modified:**

- `web/src/lib/recording/sonnet-session.ts` — feature-flag resolver, `computeBackoffDelay` static helper, `openSocket()` split, reconnect state machine, `session_resume` frame, TTL-expiry detection, close-code log.

**Unchanged:**

- `web/src/lib/recording-context.tsx` — consumer API surface unchanged; reconnect is transparent.
- All backend routes — this is client-only; the parallel Wave 4c.5 backend agent owns the server side.

---

## Recommended next

1. Merge backend Wave 4c.5 (parallel `wave-4c5-sonnet-resume-backend` branch).
2. Deploy backend first.
3. Verify the new `sessionId` appears on `session_ack` frames in staging: `aws logs tail /ecs/eicr/eicr-backend --since 5m --filter-pattern "session_ack"`.
4. Force a WS close in staging (TCP RST or ECS task kill on the user's active connection) and confirm the client reconnects + resumes without the user losing multi-turn context.
5. Flip `NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED=true` on the web task def and redeploy.
6. Monitor `[sonnet] close code=…` log lines for a week; compare against `[deepgram]` reconnect rates.
7. Post-soak, remove the flag and inline `isReconnectEnabled() === true` (Wave 5 cleanup candidate).
