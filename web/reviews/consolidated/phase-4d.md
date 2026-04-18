# Phase 4d — Consolidated Review

**Commit:** `b6c4b65` — `feat(web): Phase 4d server-side Sonnet multi-turn extraction + field propagation`
**Scope:** 4 files, +895 / -12 (sonnet-session.ts new, apply-extraction.ts new, recording-context.tsx +171/-16, recording-overlay.tsx +45/-3)
**Reviewers:** Claude, Codex (both anchored to `b6c4b65` tree, cross-checked against `src/extraction/sonnet-stream.js`).

---

## 1. Phase Summary

Phase 4d closes the "voice drives the certificate" loop on the web client. It adds a browser-side Sonnet WebSocket client (`sonnet-session.ts`), a pure `applyExtractionToJob` mapper that fans structured readings into `JobDetail` sections / `CircuitRow[]` / `ObservationRow[]`, wires recording-context to open a Sonnet session alongside Deepgram, merges Sonnet cost into the single user-facing USD ticker, and renders a gated-question strip in the overlay. Auth follows the `rules/mistakes.md` pattern (JWT via URL query, not `Authorization` header). The commit message is thorough and correctly flags the deliberate non-wiring of mid-session `job_state_update` (loop risk) and the hard-coded circuit-0 routing map.

Architecturally the split is clean (pure mapper + ref-mirrored callbacks + WS client with pre-connect queue). Both reviewers agree the feature lands, but **several protocol-level bugs in pause/resume, the certificate-type contract, and `CircuitRow` shape drift** mean the phase does not actually achieve iOS parity and needs a 4d.1 follow-up.

---

## 2. Agreed Issues

| # | Severity | Area | File : Line | Finding |
|---|---|---|---|---|
| A1 | P1 | Correctness / Protocol | `web/src/lib/recording-context.tsx:404-423` + `web/src/lib/recording/sonnet-session.ts:253-279` | **Manual `pause()` destroys the Sonnet session instead of pausing it.** `pause()` calls `sonnetRef.current?.pause()` (sends `session_pause`) and then unconditionally calls `teardownSonnet()`, which invokes `disconnect()`, which sends `session_stop`. The server deletes the session on `session_stop` (`sonnet-stream.js:780-783`), defeating the advertised 5-minute reconnect window. Net effect: every manual pause is a hard stop with a late pause ack. Verified against the b6c4b65 tree. |
| A2 | P1 | Correctness / Protocol | `web/src/lib/recording/sonnet-session.ts:247-250` + `web/src/lib/recording-context.tsx:404-415` | **`session_resume` is silently dropped on every manual resume.** `resume()` calls `beginMicPipeline()` (which constructs a new `SonnetSession` and calls `connect()` → state `'connecting'`) then immediately `sonnetRef.current?.resume()`. `SonnetSession.resume()` bails out when `state !== 'connected'`, so the frame never leaves the client. Server's `CostTracker` stays paused (or — given A1 — the session is already gone). Fix: queue `session_resume` like `sendTranscript`, or send it from `onSessionAck('reconnected'/'resumed')` / `onopen`. |
| A3 | P2 | Correctness | `web/src/lib/recording/apply-extraction.ts:233-259` | **Observation dedupe is too coarse.** Dedupes by lowercased text only, ignoring `location`, `schedule_item`, `code`. Two legitimate observations with identical text at different locations collapse into one. (Codex flags this P2; Claude flags the adjacent data-loss of `schedule_item`/`regulation` being dropped at `:251-256` — same file region, complementary facets of the same dedupe/mapping bug.) |
| A4 | Medium (Security) | Security | `web/src/lib/recording/sonnet-session.ts:290-296` | **JWT placed in WebSocket query string.** Correct per `rules/mistakes.md` for iOS Safari parity, but the bearer token will appear in ALB access logs, browser DevTools, and any Referer on redirects. Replace with a short-lived signed ticket endpoint (mirrors `api.deepgramKey(sessionId)` pattern). |
| A5 | Low (Security) | Security / Deploy hardening | `web/src/lib/recording/sonnet-session.ts:290-296` | **No host allowlist on WS URL.** `wsBase` is derived from `NEXT_PUBLIC_API_URL`; a misconfigured env variable streams audio + JWT to an arbitrary host. Assert `new URL(wsBase).host === window.location.host` in prod, or use a relative path. |
| A6 | P2 | Performance / Rerenders | `web/src/lib/recording/apply-extraction.ts:154-158, 166-230` + `web/src/lib/job-context.tsx:55-58` | **`applyExtractionToJob` returns whole section objects / cloned `circuits` arrays even when the priority guard filters every reading.** `updateJob` is a top-level shallow merge, so all `useJobContext()` consumers re-render. Add shallow-equals before assigning each section, and return `null`/skip when `circuit_updates` / `field_clears` produce no effective change. |
| A7 | P1 | Test coverage | `web/package.json` (no `test` script, no `*.test.*` / `*.spec.*` files) | **No unit or integration tests shipped.** Web workspace has no test runner configured. `applyExtractionToJob` is a pure function with ~10 decision branches; `SonnetSession` has a stateful lifecycle (connect / queue / pause / resume / reconnect). Both bugs A1 and A2 would be caught by a handful of vitest specs. Add `vitest` + minimum coverage for: pre-connect transcript queueing, pause/resume state guards, section routing, pre-existing-value preservation, `field_clears`, `circuit_updates` rename vs create, observation dedupe. |
| A8 | P2 | Accessibility | `web/src/components/recording/recording-overlay.tsx:155-179` | Questions strip itself is well implemented (`aria-live="polite"`, labelled dismiss button). Neither reviewer identifies a *new* regression; focus-trap absence on the modal pre-dates this phase. (Agreement on "no new regressions".) |

---

## 3. Disagreements + Adjudication

No direct contradictions between reviewers. All Codex findings appear in Claude's list; Claude surfaces additional findings Codex did not catch. A few nominally "unique" items from each are really complementary views on the same underlying defect — adjudicated below.

| Topic | Claude position | Codex position | Adjudication |
|---|---|---|---|
| Observation data handling | Calls out `schedule_item` + `regulation` silently dropped (data loss). | Calls out lowercased-text-only dedupe collapsing distinct defects. | **Both valid, same file region (`apply-extraction.ts:233-259`).** Merge into a single follow-up: widen `ObservationRow` to preserve `schedule_item`/`regulation` *and* strengthen dedupe key to `(code, text, location)` or `(schedule_item, code)`. |
| Pause/resume severity | P1, with full server-side reconnect-window analysis. | P1, same conclusion with slightly less server-side detail. | **Agreed P1.** Claude's analysis of the 300ms grace vs `session_stop` timing is the more complete root-cause; use it for the fix write-up. |

---

## 4. Claude-Unique Findings

| # | Severity | Area | File : Line | Finding |
|---|---|---|---|---|
| C1 | P1 | Data model | `web/src/lib/types.ts:52-56` + `web/src/lib/recording/apply-extraction.ts:182-196, 204-206` | **`CircuitRow` shape drift.** Types define `number` + `description` with index signature; 4d mapper creates rows with `circuit_ref` + `circuit_designation`. Phase 3 circuit tab rows (keyed on `number`) and 4d Sonnet rows (keyed on `circuit_ref`) live in parallel — user-typed circuits won't be found by Sonnet (duplicates created), and Sonnet-created circuits won't appear in the tab. Verified: `apply-extraction.ts:191` hard-codes `circuit_ref`/`circuit_designation`; `types.ts` only names `number`/`description`. **Real data-integrity bug, not cosmetic.** |
| C2 | P1 | Correctness / Concurrency | `web/src/lib/recording-context.tsx:290-295` | **`applyExtraction` has a stale-closure hole for `jobRef` vs batched extractions.** Reads `jobRef.current` once per extraction; back-to-back server `onBatchResult` fires (`sonnet-stream.js:500`) will both observe the pre-first-setJob snapshot. The 3-tier guard at `apply-extraction.ts:146, 214` therefore cannot see the first patch's values and can happily overwrite them. Fix: merge inside `updateJob`'s functional setter (`setJob(prev => merge(prev, result))`), or serialise extractions through a microtask queue. |
| C3 | P1 | iOS parity | `web/src/lib/recording/sonnet-session.ts:210-223` + `web/src/lib/recording-context.tsx:251` | **Regex hints never forwarded** — `sendTranscript(text)` omits `regexResults`, but server's `handleTranscript` explicitly expects them (`sonnet-stream.js:633`). `CLAUDE.md` documents "Regex provides instant ~40ms field fill" as the iOS-parity invariant. Either wire the pass-through (once `TranscriptFieldMatcher` ports) or explicitly defer to a later phase in the commit trail. |
| C4 | P2 | UX / Correctness | `web/src/lib/recording-context.tsx:311-316` | **`totalJobCost` not guaranteed monotonic across reconnects.** If `resume()` opens a new session, cost counter visibly jumps backwards. Clamp with `setSonnetCostUsd(prev => Math.max(prev, update.totalJobCost))`. |
| C5 | P2 | UX | `web/src/lib/recording-context.tsx:296-301` + `web/src/components/recording/recording-overlay.tsx:174` | **Questions dedup by text only + dismissal by index.** Two near-simultaneous dismisses can reference stale indices; legitimate re-asks (same text, different `(field, circuit)`) get suppressed. Use stable id at enqueue + `(question, field, circuit)` dedupe key. |
| C6 | P2 | Resilience | `web/src/lib/recording/sonnet-session.ts:195-203` | **Rate-limit `1008` close is treated as recoverable.** Server enforces 60 transcripts/minute and will `ws.close(1008)` on breach (`sonnet-stream.js:22-47`); client has no matching guard and surfaces it as a retryable error. Special-case `event.code === 1008` → `recoverable=false`. |
| C7 | P2 | Security (defence-in-depth) | `web/src/lib/recording/sonnet-session.ts:308-314` + `:handleMessage` field assignment | Server binary frames would crash `TextDecoder().decode()`; `reading.field` written into `CircuitRow` via index signature with no client-side allowlist (e.g. `__proto__`). Server already allowlists — acceptable defence-in-depth gap. |
| C8 | P2 | A11y / Typography | `web/src/components/recording/recording-overlay.tsx:169, 156, 188` | Question text at `text-[13px]` is below the 14px body-small threshold in `design-system.md`. Consider `aria-relevant="additions"` on the live region; wrap `errorMessage` paragraph in `role="status"`. |
| C9 | P2 | Dead surface | `web/src/components/recording/recording-overlay.tsx:85` + `RecordingSnapshot.sonnetState` | `sonnetState` exposed in snapshot but never rendered. Either show it next to `StatePill` or drop until 4e needs it. |
| C10 | P2 | Protocol telemetry | `web/src/lib/recording-context.tsx:236-250` → `sendTranscript(text)` | Deepgram confidence not threaded into Sonnet transcript frame — iOS sends it for low-confidence weighting. |
| C11 | Code quality | Future-proofing | `web/src/lib/recording/apply-extraction.ts:298-323` | 4e working tree evolved return to `{ patch, changedKeys }` for LiveFill; landing that shape at 4d would save a signature change. |
| C12 | Code quality | Magic numbers / dead code | `sonnet-session.ts:300` (`GATE_DELAY_MS` equivalent n/a here), `disconnect()` 300ms grace, `startOptions` stored but unused (`:149`), `CostUpdate` cast bypasses literal (`:362`) | Name `SESSION_STOP_GRACE_MS`; remove unused `startOptions` or wire it to reconnect-replay; defensively parse `cost_update` shape. |
| C13 | Robustness | Error swallowing | `web/src/lib/recording-context.tsx:290-295` | `applyExtraction` has no try/catch; a bad server shape would throw inside a callback and the overlay keeps ticking silently. Wrap with try/catch + `setErrorMessage`. |
| C14 | Minor | ID generation | `apply-extraction.ts:191, 249` | `crypto.randomUUID` fallback uses `c-${Date.now()}-${circuitNum}` — collides for two rows created in the same tick for the same circuit. Modern-browser fine; document the precondition. |

---

## 5. Codex-Unique Findings

| # | Severity | Area | File : Line | Finding |
|---|---|---|---|---|
| X1 | **P1 — HIGH CONFIDENCE, CLAUDE MISSED THIS** | Protocol / Contract | `web/src/lib/recording-context.tsx:301-305` + `src/extraction/sonnet-stream.js:483` | **EIC sessions start with the wrong prompt.** The client sends raw `jobRef.current` as `jobState`; `JobDetail.certificate_type` is snake_case (`types.ts:23`), but the server reads `jobState?.certificateType` (camelCase) and falls back to `'eicr'`. Verified at b6c4b65: `const certType = jobState?.certificateType || 'eicr'`. **Every EIC job on web currently runs against the EICR extractor prompt** — silent data corruption. Fix: normalise `jobState` shape on send (include `certificateType: jobRef.current.certificate_type`) or widen server to accept both. |

This one finding alone justifies flagging the phase as "Needs rework" — it is a silent correctness bug on a certificate-type code path that neither the overlay nor the server will warn about.

---

## 6. Dropped / Downgraded

| Item | Source | Action | Reason |
|---|---|---|---|
| Focus-trap absence on overlay modal | Claude §6, Codex §6 | **Dropped from 4d scope** | Both reviewers explicitly note this is a pre-existing issue from Phase 4a, not introduced by 4d. Should be tracked separately, not as a 4d.1 blocker. |
| `preConnectQueue` "nice touch" | Claude §7 | **Dropped** | Praise, not a finding. |
| Hard-coded `CIRCUIT_0_SECTION` / `supply` fallback | Codex §7 | **Downgraded to nit** | Codex itself flags this as intentional; commit body documents it as a deliberate iOS-parity choice to keep client independent of server shape drift. Monitor, don't fix. |
| `applyObservations` O(n·m) dedup | Claude §5 | **Downgraded** | Handful-of-observations scale; no user-visible impact. Kept only in test-coverage list. |
| Per-final `updateJob` cascade re-rendering | Claude §5 + Codex §5 | **Consolidated into A6** | Two phrasings of the same performance class; rolled up. |

---

## 7. Net Verdict + Top 3 Priorities

### Verdict: **Needs rework before closing the phase.**

Ship the commit as-is (it architecturally unblocks Phase 4e, which depends on the Sonnet pause/resume hooks being in place), but **land a 4d.1 follow-up before declaring Phase 4 closed.** The feature *appears* to work in a straight happy-path recording because:
- No one has manually paused a real EIC job on web yet (X1 hidden behind a code path that falls through to EICR by accident — the wrong prompt may even produce plausible output).
- The pause/resume bugs (A1, A2) only surface when the inspector actually exercises manual pause mid-job, and even then they degrade to "cold restart with history loss" rather than a visible crash.
- The `CircuitRow` shape drift (C1) only manifests once a user has hand-typed circuits on the Circuits tab and then dictates against them — something Phase 4c users haven't had cause to do yet.

### Top 3 Priorities for 4d.1

1. **Fix the `certificateType` contract mismatch (X1).** One-line normalisation on the client or a camelCase/snake_case accept-both on the server. EIC jobs are silently running through the EICR prompt today — highest-severity correctness bug in the phase.

2. **Fix pause / resume (A1 + A2).** Split `pause()` from `teardownSonnet()` so `session_pause` does not get followed by `session_stop`; queue `session_resume` until the socket is `connected` (or send it from `onSessionAck('reconnected')`). Verify by integration test: paused-then-resumed twice still has exactly one entry in server `activeSessions`.

3. **Unify `CircuitRow` shape (C1) + wire regex hints (C3) + serialise extractions (C2).** Pick one set of canonical keys (`number`/`description` matches the rest of the app + iOS `JobFormData`) and update both the type and the routing map. In the same pass, thread `regexResults` through `sendTranscript` to restore the `CLAUDE.md`-documented instant-fill invariant, and move the `applyExtractionToJob` merge inside `updateJob`'s functional setter so back-to-back extractions compose. These three together bring web behaviour into true iOS parity.

Everything else in §4–§5 can pile into a 4d.2 / Phase-5 follow-up list and does not block Phase 4 closure.
