# Wave 4c.5 Backend Handoff — Sonnet `session_ack` sessionId + `session_resume` rehydrate

**Branch:** `wave-4c5-sonnet-resume-backend` (off `web-rebuild`)
**Scope:** backend half of Wave 4c.5 — `src/extraction/sonnet-stream.js` + a new session-rehydration store. Client-side reconnect state machine is a separate agent (see `WEB_REBUILD_COMPLETION.md §2.1b`).
**Status:** 302/302 backend Jest tests green (+29 new) · web vitest 73/73 unchanged · zero new lint warnings.

---

## 1. Why this was split cross-stack

Original Wave 3 plan had "4c — Sonnet reconnect state machine" as a web-only item. Reviewer flagged it as cross-stack: `SonnetSession` on the client has no reconnect pathway today, but the *backend* also had no way for a reconnecting client to rehydrate multi-turn context — the existing `session_start` reconnection branch is keyed on the client-supplied sessionId, which a hard-reloaded browser no longer has. Splitting the work into 4c.5 (this wave) lets a client agent ship its reconnect state machine behind a feature flag against a backend protocol that already supports rehydration.

---

## 2. Protocol

### 2.1 `session_ack` frame — additive `sessionId` field

The backend now emits a server-minted UUID in every `session_ack` frame that follows `session_start` (and, as a bonus, on the `session_start`-reconnect branch too). The field is **additive** — existing clients that don't read it continue to work; the Wave 4c.5 client reads it and caches it locally so it can quote it back on reconnect.

| `status` | `sessionId` present? | When emitted |
|---|---|---|
| `started` | yes — freshly minted | First `session_start` on a brand-new session |
| `reconnected` | yes — reused from entry | `session_start` on a sessionId that is still in `activeSessions` (legacy 5-min disconnect window) |
| `resumed` (Wave 4c.5) | yes — echoes the request | `session_resume { sessionId }` hits a TTL-valid, user-matched store entry |
| `new` (Wave 4c.5) | `null` | `session_resume { sessionId }` misses — unknown / expired / wrong user |
| `resumed` (legacy wake) | absent | `session_resume` with **no** sessionId — the pre-existing sleep/wake frame, untouched |
| `paused` | absent | `session_pause` ack |
| `stopped` | absent | `session_stop` ack |
| `compact_skipped` | absent | Legacy `session_compact` — no-op since compaction was removed |

Exact JSON on the two new paths:

```jsonc
// NEW on session_start
{ "type": "session_ack", "status": "started", "sessionId": "4d1f7a7e-6c91-44d0-b94b-79b0b33a3ec5" }

// NEW on successful resume
{ "type": "session_ack", "status": "resumed", "sessionId": "4d1f7a7e-6c91-44d0-b94b-79b0b33a3ec5" }

// NEW on failed resume (unknown / expired / wrong user)
{ "type": "session_ack", "status": "new", "sessionId": null }
```

### 2.2 `session_resume` frame — dual-purpose by payload shape

The backend disambiguates the new rehydrate path from the legacy sleep/wake path by the presence of `msg.sessionId`:

```jsonc
// Wave 4c.5 rehydrate — server looks up the minted token
{ "type": "session_resume", "sessionId": "4d1f7a7e-6c91-44d0-b94b-79b0b33a3ec5" }

// Legacy sleep/wake — no sessionId, operates on the already-open socket's currentSessionId
{ "type": "session_resume" }
```

This keeps the iOS client (which uses the legacy frame for Deepgram auto-sleep/wake) working without a code change. The Wave 4c.5 client is the only caller that sets `sessionId` on the frame.

### 2.3 Security: user-boundary enforcement

Rehydration is rejected when the authenticated WS user (the `userId` resolved from the JWT at upgrade time in `src/server.js`) does not match the `userId` stored against the rehydration token. The store returns `null` in that case and **also deletes the entry** — a wrong-user probe blows the token for the legit owner too. That's a deliberately aggressive stance: once a token has leaked to another user, rehydrating the legit owner's session under it is a larger risk than making them send `session_start` from scratch.

JWT verification happens at the HTTP-upgrade layer in `src/server.js:59-90` and is unchanged; no auth logic lives inside `sonnet-stream.js`.

---

## 3. Files touched

### Added

| File | Responsibility |
|---|---|
| `src/extraction/sonnet-session-store.js` | TTL-bounded, LRU-capped in-memory store. `create(userId, payload) → sessionId`, `resume(sessionId, userId) → payload | null`, `remove(sessionId)`, `size()`, `clear()`. Singleton `sonnetSessionStore` consumed by `sonnet-stream.js`. |
| `src/__tests__/sonnet-session-store.test.js` | 19 unit tests — TTL basics, TTL anchored on mint (not on last resume), LRU eviction, LRU-touch-on-resume, user-boundary enforcement, user-mismatch invalidates token, env-var overrides. Uses injectable `now` / `mintId` so no real time / randomness. |
| `src/__tests__/sonnet-stream-resume.test.js` | 10 integration tests driving the WS handler end-to-end with a fake `ws` — session_ack carries sessionId · resume rehydrates within TTL · resume after TTL returns status=new · resume with wrong user is rejected · resume with unknown id returns status=new · legacy (no-sessionId) resume still wakes the paused session · session_stop invalidates the token. |

### Modified

| File | Change |
|---|---|
| `src/extraction/sonnet-stream.js` | (1) Import `sonnetSessionStore`. (2) On session_start: mint + store a rehydration sessionId, include it in the `started` ack. (3) On session_start reconnect branch: echo the stored rehydration sessionId on the `reconnected` ack. (4) session_resume: branch on `msg.sessionId` presence — new `handleSessionResumeRehydrate` helper handles the Wave 4c.5 path; legacy wake behaviour preserved verbatim. (5) On session_stop: `sonnetSessionStore.remove(entry.rehydrateSessionId)` to avoid leaving stale tokens around. |

### Unchanged

- `src/server.js` — upgrade path + JWT verify untouched.
- Any iOS client code — the legacy `session_resume` (no payload sessionId) continues to work identically.

---

## 4. Store shape

```ts
// sonnet-session-store.js (conceptual)
interface StoreEntry {
  userId: string;          // from the WS JWT — resumer MUST match
  payload: {               // what the caller stores
    clientSessionId: string;  // key into activeSessions on rehydrate
    jobId: string | null;
    certType: 'eicr' | 'eic';
  };
  createdAt: number;       // mint time, anchors TTL
}
```

The store deliberately holds **metadata only** — the live `EICRExtractionSession` (and its multi-turn `messages` array) stays on `activeSessions`, which is the runtime authority. The rehydration token is a pointer into `activeSessions`, not a copy of it. This means:

- Store entries are ~100 bytes each → the default 1,000-entry LRU cap is cheap.
- If the `activeSessions` entry has already been GC'd by its disconnect timer (5-min), the store rehydrate degrades to `status: 'new'` gracefully — covered by the `session_resume store hit but activeSessions entry missing` branch.

### TTL is mint-anchored, not last-touch-anchored

`sonnet-session-store.js` deliberately does **not** refresh `createdAt` on resume. Rationale (inline as a comment):

> The brief says "resume within TTL" — the token should expire on a fixed window, not be indefinitely extendable by repeated reconnects.

This is covered by the test `TTL is anchored on mint time, not on last resume (no indefinite extension)`.

### LRU-touch-on-resume

Despite mint-anchored TTL, the store **does** re-insert entries on resume so the Map's insertion order reflects recency. That keeps the LRU eviction targeting truly-cold entries (abandoned, never-resumed) when the cap fills.

---

## 5. Environment variables

| Var | Default | Purpose |
|---|---|---|
| `SONNET_SESSION_TTL_MS` | `300000` (5 min) | Window within which a `session_resume` can rehydrate. Matches the existing `activeSessions` disconnect-timer window. |
| `SONNET_SESSION_MAX_ENTRIES` | `1000` | LRU cap. 1,000 × ~100 bytes = ~100 KB worst case; safely within any container memory budget. |

Neither needs to be set in normal deploys. Tests assert both overrides work.

---

## 6. Backward compatibility

- Every new field in `session_ack` is **additive**. No existing field renamed or removed. Clients that ignore `sessionId` on the ack behave exactly as before Wave 4c.5.
- `session_resume` without `sessionId` → legacy wake path, unchanged. Covered by the test `session_resume without sessionId wakes the paused session as before`.
- `session_start` reconnect path (where the client re-uses its own sessionId within the 5-min disconnect window) still works and now also emits the rehydration sessionId on the ack — no semantic change for callers that ignore it.

---

## 7. Verification

```
$ npm test
Test Suites: 1 skipped, 14 passed, 14 of 15 total
Tests:       3 skipped, 302 passed, 305 total
```

Skipped suite is `ccu-geometric.integration.test.js` (gated on an `OPENAI_API_KEY` fixture env var — pre-existing).

```
$ cd web && ./node_modules/.bin/vitest run
 Test Files  9 passed (9)
      Tests  73 passed (73)
```

Web side unchanged — Wave 4c.5 backend introduces zero web churn.

```
$ npx eslint src/extraction/sonnet-stream.js src/extraction/sonnet-session-store.js src/__tests__/sonnet-stream-resume.test.js src/__tests__/sonnet-session-store.test.js
✖ 6 problems (0 errors, 6 warnings)
```

All 6 warnings are pre-existing in `sonnet-stream.js` (tracked in `WAVE_2B_HANDOFF.md`). Zero new lint hits from this wave.

---

## 8. Client brief (for the parallel agent)

The client agent implementing `SonnetSession` reconnect (Wave 4c.5 client half) should rely on exactly this protocol:

1. **On first `session_ack` with `status: 'started'`**: cache `ack.sessionId` in the session object (in-memory is fine — not required to survive a hard reload, though doing so would widen the recoverable window).
2. **On WS close (non-intentional)**: open a new WS, send `{ type: 'session_resume', sessionId: cachedId }`.
3. **Handle the ack**:
   - `status: 'resumed'` + matching `sessionId` → success. Resume transcript streaming; the server's multi-turn context is intact.
   - `status: 'new'` + `sessionId: null` → rehydrate failed. Fall back to `session_start` as if this were a fresh session. Surface a warning to the inspector UI (existing extraction context was lost).
4. **On `session_stop`**: stop caching the token (server invalidates it server-side).
5. **Feature flag**: `enableSonnetReconnect=false` by default. Backend is fully deployed before flipping the flag — safe because unknown clients just never send `session_resume { sessionId }`, and the backend's legacy `session_resume` (no sessionId) path is unchanged.

---

## 9. Commits

Two commits, both off `web-rebuild`:

1. **Commit A** — `feat(backend): Wave 4c.5 — session_ack carries server-minted sessionId + rehydration store` (session-store module + unit tests + session_ack field wiring).
2. **Commit B** — `feat(backend): Wave 4c.5 — session_resume rehydrate handler` (WS frame branch + integration tests).

Actual SHAs appear in the final report.

---

## 10. Recommended next unit

Once the client-side Wave 4c.5 ships (a parallel agent), the natural follow-ups are:

- **Staging manual integration test.** Open a recording session, force-close the WS mid-extraction via dev-tools, confirm reconnect+rehydrate restores the Sonnet turn history.
- **Metric for rehydrate hits vs. misses.** The store has the data (`size()`, create/resume counts) — pipe a count to `/api/metrics/*` so we can quantify the feature's real-world value. Fits cleanly with the existing telemetry sink D6 Q3 plans for outbox poisoning.
- **Promote to Redis.** If multi-instance backend becomes a thing (today the ECS service runs 1 task), swap the in-memory store for `ioredis` — the `createSessionStore` interface is deliberately narrow so only the implementation changes. This wave's brief explicitly deferred that to a future wave.
