# Phase 4d — Code Review

**Commit:** `b6c4b65` — `feat(web): Phase 4d server-side Sonnet multi-turn extraction + field propagation`
**Scope:** 4 files, +895 / -12
**Files:**
- `web/src/lib/recording/sonnet-session.ts` (new, 375 lines)
- `web/src/lib/recording/apply-extraction.ts` (new, 316 lines)
- `web/src/lib/recording-context.tsx` (+171 / -16)
- `web/src/components/recording/recording-overlay.tsx` (+45 / -3)

Reviewed against the as-shipped 4d tree (`git show b6c4b65:…`), cross-checked with the server contract in `src/extraction/sonnet-stream.js` and the 4e evolution in the working copy.

---

## 1. Summary

Phase 4d closes the voice-drives-the-form loop on web. It wires a WebSocket client to the existing server-side Sonnet multi-turn extractor (which iOS has run against for a year), merges structured readings into `JobContext`, queues gated questions in the overlay, and proxies cost deltas through to the single user-facing USD ticker. The commit message is unusually thorough, correctly flags the deliberate non-implementation of mid-session `job_state_update`, and cites the canonical iOS parity points (`rules/mistakes.md` on WS auth, fix `4c75ccf` for pause-before-teardown). The architecture is sound: two refs + a separate `applyExtractionToJob` pure function keep the Sonnet fan-out side-effects out of the React tree, and the 3-tier priority is implemented exactly where it has to be (client-side guard against a stale `job_state_update` snapshot).

A handful of **real P1 bugs** around session reconnect, pause/teardown semantics, and a silent type-shape drift on `CircuitRow` that will cause `updateJob` patches to collide with other surfaces. No security-critical defects.

---

## 2. Alignment with Phase 4d Brief

| Requirement | Status | Notes |
|---|---|---|
| WebSocket to `/api/sonnet-stream` | OK | URL-query token matches `rules/mistakes.md`. |
| Multi-turn lifecycle (`session_start` / `transcript` / `pause` / `resume` / `stop`) | OK | All five outbound + five inbound message types handled. |
| JSON-only enforcement on Sonnet outputs | N/A on client — enforced server-side via tool-use (`src/extraction/eicr-extraction-session.js:516, 570`). Client trusts server shape. |
| Field propagation priority (Pre-existing > Sonnet > Regex) | OK for Pre-existing > Sonnet. **Regex layer not yet wired on web** — see §3 P2. |
| Cost guards / compaction | Compaction removed server-side (`sonnet-stream.js:9`, `:391-401`). Client only consumes `cost_update`. No client-side budget ceiling — see §3 P2. |
| Integration with regex hints pipeline | **Not implemented.** `sendTranscript` does not forward `regexResults`; see §3 P1 item 3. |
| Question queue + dismissal | OK (capped at 5, text-deduped). |
| Pause before teardown | Partial — see §3 P1 item 1. |
| iOS parity on protocol | OK except for the regex-hints gap. |

---

## 3. Correctness

### P0 — blocks merge

None.

### P1 — fix before ship

**1. `pause()` tears the Sonnet WS down immediately after sending `session_pause` (race).**
`recording-context.tsx:b6c4b65 lines 411–423` (shown as b6c4b65 tree):
```
sonnetRef.current?.pause();
clearTick();
teardownMic();
teardownDeepgram();
teardownSonnet();   // ← calls sonnetRef.current?.disconnect() synchronously
```
`sonnet-session.ts:242–245` sends `{ type: 'session_pause' }` via `send()`, and `disconnect()` (sonnet-session.ts:255–280) then queues `session_stop` plus a 300ms grace close. Result: **every manual pause triggers a full `session_stop` 300ms later**, not a pause. That:
  - Removes the session from `activeSessions` after ~300s timeout would otherwise apply (server sees stop, not close).
  - Defeats the reconnect-window design documented in `sonnet-stream.js:428–439`.
  - Forces `resume()` to do a cold `session_start`, which works (reconnect branch at `sonnet-stream.js:449`) **but only if the 300s disconnect timer is still pending** — since `session_stop` tells the server to `activeSessions.delete(sessionId)` (sonnet-stream.js:783), the session is actually gone.

The commit message explicitly says "pause sends `session_pause` BEFORE tearing down the WS" — which is technically the order in the code, but the teardown also calls `session_stop`, so the net effect is a hard stop plus a late pause. Either (a) have `pause()` send `session_pause` and keep the WS open (closer to the 4e wake-from-doze model in the working tree), or (b) drop `session_stop` from `disconnect()` when the caller has already signalled `session_pause`.

**2. `resume()` opens a fresh `SonnetSession` and immediately calls `.resume()` on it.**
`recording-context.tsx:b6c4b65 lines 428–440`:
```ts
await beginMicPipeline();        // ← this also calls openSonnet() which session.connect()
sonnetRef.current?.resume();     // ← sent immediately
```
`SonnetSession.resume()` at `sonnet-session.ts:248–251` bails when `state !== 'connected'`:
```ts
if (!this.ws || this.state !== 'connected') return;
```
At the moment `.resume()` is called, the socket has just been constructed and is `'connecting'` (see `connect()` setState at `sonnet-session.ts:150`). `onopen` only fires on the next microtask+. So **every manual resume silently drops the `session_resume` message** and the server never gets told to un-pause the `CostTracker` (`sonnet-stream.js:373–389`). Cost tracking will either stay paused (if item 1 above were fixed) or, in the current code, the server treats the fresh `session_start` as a reconnect and the `session_resume` is the wrong signal anyway. Fix: queue `session_resume` the same way `sendTranscript` queues pre-connect (sonnet-session.ts:213–216), or call `.resume()` from `onSessionAck('reconnected')`.

**3. Regex hints are never forwarded — iOS-parity gap vs `CLAUDE.md`.**
`CLAUDE.md` documents the iOS pipeline as `... TranscriptFieldMatcher (instant regex) -> ServerWebSocketService + regex hints -> Backend: Sonnet extraction (with regex context)`. The server's `handleTranscript` expects `msg.regexResults` (`sonnet-stream.js:633`) and feeds it into `session.extractFromUtterance(msg.text, regexResults, …)`. `sonnet-session.ts:218–222` sends only `{ type: 'transcript', text, confirmations_enabled }`. Without regex hints, Sonnet's 1-2s extraction is the *only* source of field fills on web, violating the "Regex provides instant ~40ms field fill" invariant in `CLAUDE.md`. This should either be explicitly deferred to a future phase (note in overlay/commit body) or implemented as a straight pass-through once `TranscriptFieldMatcher` ports.

**4. `CircuitRow` shape drift — Sonnet-filled rows are isolated from Phase 3 rows.**
`apply-extraction.ts:191–196` creates rows with `{ id, circuit_ref: ref, circuit_designation: '' }` and `:182–184` looks up by `row.circuit_ref ?? row.number`. But `types.ts:52–56` at b6c4b65 types `CircuitRow` as `{ id, number?, description?, [key: string]: unknown }`. The canonical keys on the rest of the web app are `number` + `description`; this patch adds a *second* parallel set (`circuit_ref`, `circuit_designation`). Practical consequences:
  - Circuits created by the user in the Circuits tab won't be found by Sonnet (they have `number: "3"`, not `circuit_ref: "3"`) → Sonnet creates a duplicate row.
  - Circuits created by Sonnet won't show in tabs keyed on `number`/`description`.
  - The 3-tier priority guard at `:214` reads `row[reading.field]` — fine for the index-signature fields Sonnet writes, but the guard at `:204` against `row.circuit_designation` won't fire for a user-entered `description`.
  Pick one shape (probably `number`/`description` to match Phase 3 + iOS `JobFormData`), update both the type + the routing map.

**5. `observations` deduped against `description` but Sonnet sends `observation_text`.**
`apply-extraction.ts:240` dedupes existing observations by `(o.description ?? '').trim().toLowerCase()` (matches `ObservationRow`), and new observations by `obs.observation_text` (matches Sonnet's `Observation`). Correct. But the observation *code* roundtrip is lossy: Sonnet returns `{code, observation_text, item_location, schedule_item, regulation}` and only `code`/`observation_text`/`item_location` are persisted into `ObservationRow` (`:251–256`). `schedule_item` and `regulation` are silently dropped, which matters for EICR forms that need regulation references on the printed schedule. P1-ish because it's data loss; re-widen `ObservationRow` or stash them on `[key: string]: unknown`.

**6. `applyExtraction` has a stale-closure hole for `jobRef` vs batched extractions.**
`recording-context.tsx:b6c4b65 lines 290–295`:
```ts
const applyExtraction = React.useCallback((result: ExtractionResult) => {
  const patch = applyExtractionToJob(jobRef.current, result);
  if (patch) updateJobRef.current(patch);
}, []);
```
`applyExtractionToJob` reads `jobRef.current` once, computes a patch, and the patch is then `...prev, ...patch` merged inside `updateJob`. If two `extraction` messages arrive back-to-back (server-side `onBatchResult` can fire asynchronously per `sonnet-stream.js:500`), the second call reads `jobRef.current` *before* the first `setJob` has flushed (React 19 batches but still one tick later). The "pre-existing value" guard (`apply-extraction.ts:146, 214`) will therefore not see the first patch's values and can happily overwrite them. This is a real regression from the iOS serial path. Either: (a) do the merge functionally inside `updateJob`'s setter (`setJob(prev => merge(prev, result))`), or (b) queue extractions through a microtask and drain serially.

### P2 — follow-up

**7. URL-query token logged in access logs / proxy logs.**
`sonnet-session.ts:290–297` puts the JWT in the querystring. That's correct for iOS Safari parity (per `mistakes.md`) but it will appear verbatim in ALB access logs, browser dev-tools network tab, and any Referer header on redirects. Consider either (a) using a per-session short-lived signed ticket (same as `api.deepgramKey(sessionId)`) instead of the user JWT, or (b) exchanging a one-shot nonce on `handleSessionStart`. The iOS client has the same issue today — fix together.

**8. No Sonnet client-side budget guard.**
The server enforces a 60 transcript / minute sliding-window limiter (`sonnet-stream.js:22–47`) and will `ws.close(1008)` on breach. The client has no matching guard and no handling for a `1008` close — `onclose` will flag `code !== 1000` as a recoverable error and the caller will just see a red overlay. Add either a client-side mirror limiter, or an `onError(recoverable=false)` path on 1008 to reset instead of retry.

**9. `totalJobCost` is not guaranteed monotonic across reconnects.**
`recording-context.tsx:b6c4b65 lines 311–316` does `setSonnetCostUsd(update.totalJobCost)` directly. On reconnect the server emits a new `cost_update` after `flushPendingExtractions` (`sonnet-stream.js:592`), which is cumulative for the session — that's fine. But if `resume()` opens a *new* session (see P1 item 1), `totalJobCost` resets to near-zero and the UI cost counter will visibly jump backwards. Add `Math.max(prev, update.totalJobCost)`.

**10. Questions `[index]`-keyed dismissal.**
`recording-overlay.tsx:174` calls `dismissQuestion(i)`. With `aria-live="polite"` and rapid appends, two near-simultaneous dismiss clicks can reference stale indices. Track by a stable id (`question:${n}` generated on enqueue) instead.

**11. `questions` duplicated by `question` string only.**
`recording-context.tsx:b6c4b65 lines 296–301` dedupes by `.question`. Sonnet's prompt can legitimately re-ask the same text for a different `(field, circuit)` tuple. Use `${question}|${field}|${circuit}` as the dedup key.

**12. `sonnetState` is declared in `RecordingSnapshot` but the overlay never renders it.**
`sonnetState` is exposed for "overlay diagnostics" per the commit body, but `recording-overlay.tsx` never reads it. Either surface a small pill next to `StatePill` (which would match "deepgramState" parity mentioned in the type comment at `:82`), or drop it from the public surface until 4e uses it.

**13. Transcripts sent to Sonnet without a confidence / sequence number.**
iOS sends the Deepgram confidence so Sonnet can weight low-confidence finals. Web `sendTranscript(text)` at `recording-context.tsx:251` drops it. Minor but visible in the server logs ("textPreview" only, no confidence).

**14. `applyExtractionToJob` returns only a patch — caller has no way to know which fields Sonnet filled.**
Working-tree 4e evolved this into `{ patch, changedKeys }` to drive `LiveFillState`. At 4d the shipped signature (`Partial<JobDetail> | null`) means the overlay cannot even show "fields just updated: ze, pfc" without a separate pass over `result.readings`. This is fine for the phase boundary but worth flagging as a future-shape constraint.

**15. `crypto.randomUUID` fallback uses `Date.now()` with a single counter bucket.**
`apply-extraction.ts:191, 249` fall back to `c-${Date.now()}-${circuitNum}` / `obs-${Date.now()}-${len}`. Two new rows created in the same tick for the same circuit number get identical ids. In `apply-extraction.ts` this only matters if `crypto.randomUUID` is undefined (SSR, old Safari), but the React keying and the `prevIds` dedup in `diffObservationKeys` (seen in working tree) will then mis-key. Fine in practice on modern browsers; document the precondition.

---

## 4. Security

- **JWT in URL querystring** — see §3 P2 item 7.
- **No input validation on server messages.** `sonnet-session.ts:handleMessage` trusts whatever the server sends. Since both sides are controlled and WSS is auth'd, this is acceptable, but `result.readings` is cast via index signature into `CircuitRow[reading.field] = reading.value` with no allowlist. A compromised backend could inject e.g. `__proto__` or `constructor` as a field name. `Object.create(null)` on row seed or an explicit `reading.field in KNOWN_FIELDS` guard would close it. The server does allowlist (`sonnet-stream.js:52–172`), so this is defence-in-depth.
- **No origin check on outbound WS URL.** `api.baseUrl` is derived from `NEXT_PUBLIC_API_URL`; if that env var is mis-set on deploy the browser happily opens a WS to any host and streams audio + JWT to it. Assert the hostname matches `window.location.host` on prod, or use a relative `/api/sonnet-stream` URL with scheme flip.
- **ArrayBuffer decode path in `handleMessage`** (`sonnet-session.ts:310–312`) uses `new TextDecoder().decode(data as ArrayBuffer)`. Binary frames from the server would crash this branch if they aren't valid UTF-8; server only sends JSON text frames today, so not exploitable. Worth a `data instanceof ArrayBuffer` check.

---

## 5. Performance

- **Per-final `updateJob` cascade.** Each Sonnet extraction returns a patch; `updateJob` replaces entire section objects; downstream Phase 3 tab components that pick off `job.supply.ze` will all re-render. Fine at 1–2s extraction cadence, but `applyExtractionToJob` always produces a fresh object for each touched section (`:156` `{ ...existing, ...bySection[section] }`) even when nothing actually changed after the priority guard filters everything out — because the `bySection` seed was populated earlier. Add a shallow-equals check before assigning `patch[section]` at `:346`.
- **`applyObservations` O(n·m) dedup** — OK given the expected handful of observations.
- **`setInterval(fn, 100)` cost ticker** (`recording-context.tsx:177–185`) fires through doze because `pause()` only calls `clearTick()` *after* `teardownSonnet()`. Not a real perf issue, just mentioning as part of the pause ordering discussion in P1 item 1.
- **`setTranscript(prev => next.length > 10 ? next.slice(next.length - 10) : next)`** is O(n) per final — fine, and it enforces the 10-utterance cap.
- **Interim transcripts do not fire Sonnet.** Correct — avoids the AGC self-feed, matches the iOS comment in `recording-context.tsx:256–258` (working tree). At 4d the equivalent dead-code risk doesn't exist yet.

---

## 6. Accessibility

- `aria-live="polite"` on the questions strip — good (`recording-overlay.tsx:156`).
- Dismiss button has `aria-label="Dismiss question"` and is keyboard-reachable — good.
- The question text inside `.flex-1` uses `text-[13px]` which is below the 14px body-small threshold in `design-system.md`. Should be 14px.
- The new question strip is keyed by index — fine for rendering, but if a new question is inserted while a screen-reader is mid-announcement, `aria-live` will restart. Consider `aria-relevant="additions"`.
- `StatePill` doesn't include the `sonnetState` (parity with `deepgramState` which also isn't shown — both hidden from screen readers). If `sonnetState === 'error'` the user only sees `errorMessage` in the transcript panel, with no status-region announcement. Add `role="status"` to the error `<p>`.
- No focus trap on the overlay `<div role="dialog" aria-modal="true">`. Tab will escape to the page underneath. Existing issue from 4a, not introduced here.

---

## 7. Code Quality

- **Excellent per-call comments** across all four files — Derek's style, and it really pays off in `recording-context.tsx`.
- **Public callback surface is cleanly typed** — every inbound shape has an exported interface in `sonnet-session.ts`, which is what you want for a WS client.
- **Pre-connect queueing (`preConnectQueue`)** is a nice touch and matches the server's `preSessionBuffer` on the other end.
- **`setState` guard** (`sonnet-session.ts:284–288`) prevents redundant callback fires — sensible.
- **Export hygiene:** `hasValue` and `parseObservationCode` aren't exported at b6c4b65 (they are in the 4e working tree). They're pure and reusable — exporting makes testing easier.
- **Dead type.** `CostUpdate.type: 'cost_update'` literal is asserted but the narrowing assertion at `:362` uses `json as unknown as CostUpdate` which bypasses the literal check. Either parse the whole shape defensively or drop the literal.
- **Magic constants.** `GATE_DELAY_MS = 2500` lives server-side; 300ms grace in `disconnect()` is a magic number — name it `SESSION_STOP_GRACE_MS`.
- **Double-reference handoff pattern** (`jobRef` / `updateJobRef`) is correct but brittle: anyone else adding a callback here has to remember to refresh the ref. A tiny `useLatestRef(value)` helper would document intent.
- **`recording-context.tsx:290–295` swallows all errors** — if `applyExtractionToJob` throws (bad server shape, or a guard bug), the overlay keeps ticking and the user has no feedback. Wrap in try/catch + `setErrorMessage`.

---

## 8. Test Coverage

**No tests ship with Phase 4d, and the web workspace has no test runner configured** (`web/package.json` scripts: `dev`, `build`, no `test`; no `*.test.*` or `*.spec.*` files exist). This is the single biggest risk in the phase. `apply-extraction.ts` is a pure function that *should* have unit tests — it has ~10 decision branches (circuit 0 vs >=1, rename vs create, clear vs reading, pre-existing vs fresh, EIC vs EICR-only sections) and every one of the P1 bugs above would be caught by a 30-line vitest spec.

**Missing coverage (all achievable without a browser):**
1. `applyExtractionToJob` given a circuit-0 reading with existing value → no overwrite.
2. Given a circuit-3 reading + no existing row → new row created, reading applied.
3. Given a `rename` circuit_update → designation replaced; given `create` + existing non-empty designation → preserved.
4. Observations dedup on case-insensitive `description`/`observation_text` equivalence.
5. `SonnetSession.sendTranscript` queues when `state === 'connecting'`, flushes on `onopen`.
6. `SonnetSession.pause/resume` no-op when disconnected.
7. `handleMessage` with malformed JSON does not throw.

---

## 9. Suggested Fixes (numbered, file:line)

Numbering carried from §3/§4/§5/§6/§7.

1. `web/src/lib/recording-context.tsx:411–423` — split `pause()` from `teardownSonnet()`. `pause()` should send `session_pause` and **keep** the Sonnet WS open (matches the 4e working-tree `onEnterDozing` behaviour).
2. `web/src/lib/recording/sonnet-session.ts:248–251` + `web/src/lib/recording-context.tsx:434–436` — queue `session_resume` until `state === 'connected'`, or send it from `onSessionAck('reconnected'|'resumed')`.
3. `web/src/lib/recording/sonnet-session.ts:210–223` + `web/src/lib/recording-context.tsx:251` — accept an optional `regexResults` argument on `sendTranscript`; forward as `{regexResults}` to match `sonnet-stream.js:633`.
4. `web/src/lib/types.ts:52–56` + `web/src/lib/recording/apply-extraction.ts:182–196, 204–206` — unify on `number`/`description` (not `circuit_ref`/`circuit_designation`), or add both to the type and pick one as canonical in one place.
5. `web/src/lib/recording/apply-extraction.ts:251–256` — preserve `schedule_item` + `regulation` on `ObservationRow` (either widen the type or stash under `[key: string]`).
6. `web/src/lib/recording-context.tsx:290–295` — do the merge inside `updateJob`'s functional setter, reading `prev` not `jobRef.current`, so back-to-back extractions compose.
7. `web/src/lib/recording/sonnet-session.ts:290–297` — move JWT off the query string. Mint a short-lived signed ticket on a `GET /api/sonnet-stream/ticket` endpoint.
8. `web/src/lib/recording/sonnet-session.ts:195–203` — treat `ws.close` code `1008` specially; surface `recoverable=false`.
9. `web/src/lib/recording-context.tsx:314–316` — `setSonnetCostUsd(prev => Math.max(prev, update.totalJobCost))`.
10. `web/src/lib/recording-context.tsx:296–301` + `web/src/components/recording/recording-overlay.tsx:174` — add a stable id to each question at enqueue time; `dismissQuestion` takes the id, not the index.
11. `web/src/lib/recording-context.tsx:298` — dedup key = `${question}|${field ?? ''}|${circuit ?? ''}`.
12. `web/src/components/recording/recording-overlay.tsx:85` — render `sonnetState` next to `StatePill`, or drop `sonnetState` from `RecordingSnapshot` until needed.
13. `web/src/lib/recording-context.tsx:236–250` — thread Deepgram `confidence` into `sendTranscript(text, { confidence })`; add to the outbound frame.
14. `web/src/lib/recording/apply-extraction.ts:298–323` — return `{ patch, changedKeys }` now (4e-shape) so the overlay can light up filled cells in the next phase without another signature change.
15. `web/src/lib/recording/apply-extraction.ts:191, 249` — use `crypto.randomUUID` unconditionally on modern targets; note the assumption in a top-of-file comment.
16. `web/src/lib/recording/sonnet-session.ts:290–297` — assert `new URL(wsBase).host === window.location.host` (or equivalent allow-list) before `new WebSocket(url)`.
17. `web/src/lib/recording/sonnet-session.ts:308–314` — guard `data instanceof ArrayBuffer` before `TextDecoder().decode()`.
18. `web/src/lib/recording/apply-extraction.ts:154–158` — shallow-equals the section before emitting into `bySection`.
19. `web/src/components/recording/recording-overlay.tsx:169` — bump question text to `text-[14px]`; add `aria-relevant="additions"` on the live region at `:156`.
20. `web/src/components/recording/recording-overlay.tsx:188` — wrap `errorMessage` paragraph in `<p role="status">`.
21. **Add `vitest` to the web workspace** + the seven tests listed in §8.
22. `web/src/lib/recording-context.tsx:290–295` — wrap `applyExtractionToJob` call in try/catch + `setErrorMessage`.

---

## 10. Verdict + Top 3 Priorities

**Verdict:** Architecturally sound and a meaningful feature ship — the Sonnet WS client, pure `applyExtractionToJob`, ref-mirrored job state, and question queue are all well factored and will last. However, three issues together mean the **pause/resume path does not actually work as iOS parity** and **every Sonnet-extracted circuit row is invisible to the user's hand-entered circuit rows** — these materially break the "voice drives the certificate" story the phase exists to deliver.

Not a revert candidate. Ship the commit (it unblocks 4e, which it does), but **land a 4d.1 follow-up** before closing the phase.

**Top 3 priorities for 4d.1:**

1. **Fix pause/resume.** (Suggested fixes §9 #1 + #2.) Without this, manual pause is effectively `stop()`+ghost session, and resume silently loses `session_resume`. Easy to verify: one integration test that paused-then-resumed twice still has one entry in the server's `activeSessions` map.

2. **Unify `CircuitRow` shape.** (§9 #4.) Decide `number` vs `circuit_ref` and make the whole codebase + the field-routing map use one name. This is a data-integrity bug, not cosmetic.

3. **Wire regex hints + serialise extractions.** (§9 #3 + #6.) The first restores the `CLAUDE.md`-documented instant-fill UX. The second prevents Sonnet from racing itself when two finals land within an extraction cycle. Together they bring web behaviour back into alignment with iOS.

All other items are P2 and can pile into a follow-up list.
