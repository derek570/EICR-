# Plan C — retire (or re-gate) the iOS misheard-clarification net

**Feedback ids:** 95, 96, 97 · session `2D8E432D` (pre-`:344`)
**Repos:** `CertMateUnified/` only — **web has no equivalent net**
**Verification lane:** iOS unit + device smoke (TestFlight)

---

## 1. Problem

Three separate feedback reports from the same session are **one bug**:

| id | Derek's report | Reality |
|---|---|---|
| 95 | "It keeps asking if it misheard me when it didn't" | `misheard_clarification` false positive |
| 96 | "It said the server disconnected" | **No disconnect occurred.** The session had exactly one backend WS drop and one Deepgram drop in its entire length; the prompt Derek heard was the same misheard net |
| 97 | "It feels laggy" | Perceived lag is largely the spurious ~6 s apology TTS firing after readings that had already been understood |

The net fires ~6 s after a reading, asks the inspector to repeat something the system already extracted correctly, and — because it is phrased as a clarification — reads to the user as a failure or a disconnect.

## 2. Evidence

`CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift:3380–3412` schedules the check on a **fixed 6.0 s timer** racing a **variable-latency multi-round server**:

```swift
pendingMisheardCheck = workItem
DispatchQueue.main.asyncAfter(deadline: .now() + 6.0, execute: workItem)
```

The source comment above it already documents this exact bug recurring **and being mis-reported as a disconnect**:

> *"item #9 (session DFCE2145, 2026-06-23) — bumped 3.0 → 6.0s. The old 3s delay was SHORTER than a multi-round server round-trip … the cancel-on-extraction lost the race and the inspector was nagged to repeat a reading the system had already understood (**mis-reported as a "server disconnect" prompt; no disconnect occurred**). … A genuinely-dropped reading is now caught server-side by the deterministic orphan net (`stage6-shadow-harness.js`, item #10), so lengthening this client heuristic loses no drop coverage — it only removes the false positive."*

So: **the same fix has already been attempted once by widening the timer, and the bug came back.** Widening a fixed timeout cannot win a race against an unbounded-latency server; it only moves the failure threshold.

Supporting code:

- `…DeepgramRecordingViewModel.swift:4660–4840` — `checkForMisheardElectrical(normalised:regexFoundMatch:)`: guard chain (`postReconnectSuppressUntil`; no active alert/TTS/queued/pendingQuestions; 45 s cooldown; `!regexFoundMatch`; `regexAge > 15`; `sonnetAge > 15`; wordCount 2–20; ring-continuity suppression) then fires on nearMissField+decimal or electricalContext+decimal.
- `…:4633–4676` — `cancelMisheardAlertsAndExtendGrace(trigger:)`: cancels on WS/Deepgram transitions and re-arms a 30 s grace.
- **Web has no such net.** A sweep of `web/src/` for `misheard` returns only an unrelated comment at `web/src/lib/recording/number-normaliser.ts:250`.

## 3. Root cause

A client-side heuristic that duplicates coverage the server now owns, implemented as a fixed-delay race it cannot reliably win.

Since this net was written, the server has grown a full audibility guarantee stack:

- the A3 orphan net (`stage6-shadow-harness.js`) — catches genuinely-dropped readings,
- **marker-①** — a chimed no-op always speaks,
- **marker-②** — a chimed turn with zero audible output always speaks (`CATCHALL_AUDIBILITY_PROMPTS`, `src/extraction/stage6-shadow-harness.js:452`),
- the F7 pre-emission ask-audibility net,
- the P4 answered-ask decline-acknowledgment net.

Together these enforce Derek's *"chime is a promise"* rule server-side. The client net adds no coverage — by its own comment — and contributes false positives, spurious TTS, and perceived latency.

## 4. Fix

**Primary: delete the net.**

1. Remove the 6.0 s scheduling site (`:3380–3412`) and `checkForMisheardElectrical` (`:4660–4840`).
2. Remove `cancelMisheardAlertsAndExtendGrace` and the `pendingMisheardCheck` / cooldown / `postReconnectSuppressUntil` state that exists solely to service it. Keep any state a *different* feature reads — audit each field before deleting.
3. Leave the server-side nets untouched; they are the replacement.
4. Keep the `misheard_*` debug-log events **only if** something still emits them; otherwise remove so the analytics schema does not carry dead signals.

**Fallback if review shows residual coverage:** re-gate rather than delete —
- replace the fixed 6.0 s timer with cancellation driven by an explicit **server "turn resolved" signal** (the same generation/epoch correlation P4c/P4d already thread), so the net can only fire when the server has demonstrably finished the turn and produced nothing; and
- suppress entirely whenever any server audibility net has spoken this turn.

The plan's default is deletion. `/rp` should adjudicate whether any coverage genuinely remains that the server nets do not provide — if the answer is "none", the fallback is dead weight.

## 5. Files

| File | Change |
|---|---|
| `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift:3380–3412` | remove scheduling site |
| `…:4633–4676` | remove cancel/grace helper (audit for other callers first) |
| `…:4660–4840` | remove `checkForMisheardElectrical` |
| iOS tests referencing the net | delete or convert to a regression pin asserting the net no longer fires |

## 6. Tests

- **iOS unit** — a reading that previously tripped the net (near-miss field + decimal, no regex match, stale regex/sonnet ages) now produces **no** clarification TTS.
- **iOS unit** — a genuinely dropped reading still produces exactly one spoken response, sourced from the server nets (assert via the existing server-frame fixtures, not by re-implementing the net).
- **Regression pin** — assert `checkForMisheardElectrical` / `pendingMisheardCheck` no longer exist, so the net cannot be reintroduced by a future merge without the pin failing.
- **Device smoke** — a normal multi-reading dictation session with AirPods: zero "did I mishear" prompts, zero false disconnect prompts.

## 7. Web companion

**Not applicable — no web change needed.** Web never had this net (verified: no `misheard` net in `web/src/`). Record a dated parity-ledger note on the relevant recording row stating the net is iOS-only and now removed, so the gap is not later "closed" by porting a deleted feature to web. Owner: **Derek**.

## 8. Risks

- **Coverage regression.** If a drop class exists that only this net caught, removing it makes that class silent. Mitigation: the net's own comment asserts the opposite; validate by replaying session fixtures through the server nets and confirming every dropped reading still draws exactly one spoken response.
- **Shared file with plan D.** Both plans edit `DeepgramRecordingViewModel.swift` in different regions. Land one, re-run the iOS suite, then the other.
- **Perceived-latency claim (id 97) is partly separate.** Removing the spurious TTS should account for most of it, but if lag persists after the TestFlight build, that is a fresh investigation — do not fold speculative latency work into this plan.

## 9. Acceptance criteria

1. No client-side misheard-clarification prompt can fire.
2. A genuinely dropped or garbled reading still produces exactly one spoken response, from the server nets.
3. Session `2D8E432D`'s reading sequence, replayed, produces zero clarification prompts.
4. Full iOS suite green; device smoke shows no spurious prompts.
