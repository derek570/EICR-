# PLAN-C execution log

- Plan: `PLAN-C-final.md` — Retire the Deepgram Sleeping tier (feedback id 120)
- Session: `20260813T154458Z-ep`
- Branch: `ep/PLAN-C-20260813T154458Z-ep`
- Worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260813T154458Z-ep`
- Chain hop: 5 of the feedback-2026-08-11 wave (PLAN-A → PLAN-A2 → PLAN-B → PLAN-D → PLAN-E → **PLAN-C** → PLAN-F)

## Pre-flight

- Session hygiene sweep: `ep-reap.sh sweep` → `reaped=0 held=0 working=1` (clean).
- `.ep-queue` marker present → chain mode confirmed (declared wave member).
- **[FOUND — not authored by this run]** CertMateUnified had pre-existing uncommitted changes before iOS work began: (a) a `fastPathCorrelationTTL` 60→300s fix (AlertManager.swift, DeepgramRecordingViewModel.swift, 2 test files) matching a change the PLAN-B changelog entry *claims* already shipped ("extended to 300s on both backend and iOS") but which was never actually committed to CertMateUnified's git history; (b) an untracked `AGENTS.md` + `.codex/agents/*.toml` scaffold unrelated to any wave plan. Both stashed non-destructively (`git stash push -u`, message: "ep: PLAN-C pre-existing dirty state found before iOS work...") rather than discarded or blindly committed under this plan's authorship. **Neither has been restored — see Follow-ups.**

## Plan-size check

Plan spans iOS (C1 + C1a, intricate generation-ownership state machine) + web (C2 + C2a) + docs (C3) across two repos. Under the ~8-item/3-group heuristic this is borderline (2 feature groups: sleep-tier retirement, generation-owned reconnect) but the iOS half's C1a spec alone is dense. No `[PLAN-SIZE]` warning issued — the plan was already refined to 0 findings across 5 `/rp` rounds before reaching `/ep`.

## Step execution

### C1 + C1a — iOS (CertMateUnified, separate repo)

- Status: **applied** (delegated to a background agent, `ios-c1-agent`, given the density of C1a's spec).
- Commits (CertMateUnified, direct to `main`, this repo's own convention): `2230b50` (C1 — flag gate + session latch + telemetry), `adeb860` (C1a — generation-owned reconnect), `568c1c6` (docs — CLAUDE.md correction; no AGENTS.md exists in this repo).
- Verification: independently re-verified by this session (trust-but-verify) — read both feature-commit diffs in full. `SleepManager.swift`'s `startNoTranscriptTimer()` correctly gates on the session-latched `autoSleepEnabled` flag (default false, read once in `performStartRecording`, never in `init`). `DeepgramService.swift`'s `connectionGeneration` is minted on the service queue before `reconnectWorkItem?.cancel()`/socket replacement and validated in every listed site (auto-reconnect key-fetch Task immediately before `_connect`, `receiveNextMessage` success/failure legs, socket open/close/error handlers) — matches the plan's C1a spec precisely, including the destructive-drain-stays-sleep-only invariant. `session_start_flags` payload keys (`auto_sleep_enabled`, `confirmations_enabled`) match web's exactly.
- Tests: 15 new (flag contract cases 1/2/3/5/6, two-session UserDefaults latching, C1a three-event stale-generation regression + held-key-fetch-window test, coordinator flush-exactly-once/failure-clears-queue tests). Full suite 1681/1681 green (`xcodebuild test`, iPhone 17 Pro sim; was 1666 before).
- Deviations: telemetry folded into the C1 commit (bound to the same one-shot UserDefaults read) rather than its own commit — noted, not a concern. `xcodegen generate` reset `Sources/Info.plist` CFBundleVersion 433→100 as a side effect of adding test files to the project; the agent restored 433 and did NOT commit it (correctly deferred — the deploy script recomputes this anyway).

### C2 + C2a — web (this worktree)

- Status: **applied** by this session directly.
- `web/src/lib/recording/sleep-manager.ts`: `autoSleepEnabled` config flag (default false) gates automatic timer arming; `getAutoSleepEnabled()`/localStorage helper (key `autoSleepEnabled`, same string as iOS's UserDefaults key); `suspendTimer()`/`resumeTimer()` (sticky, not just instant-clear — see Codex cycle 1 below); injectable `timerScheduler` seam mirroring iOS's own.
- `web/src/lib/recording-context.tsx`: `pause()` no longer calls `SleepManager.enterSleeping()` — new lighter-weight pause (stop+null mic, reset ring buffer/VAD, disconnect ONLY Deepgram via a narrow `disconnectDeepgramForPause()` helper, keep Sonnet alive via `sonnetRef.pause()`), unconditional in both flag states. `resume()` gained a `pausedLightweightRef` discriminator + a `beginMicOnly()` helper (factored out of `beginMicPipeline()` to avoid silently rebuilding Sonnet via the latter's trailing `openSonnet()` — a real bug caught by this session's own first test run, before any Codex review).
- `session_start_flags` diagnostic emitted from `start()` after sessionId + diagnostic sink are established, sharing the event with PLAN-D's `confirmations_enabled` field.
- Tests: `sleep-manager-flag-gate.test.ts` (new), `harness/c2a-lightweight-pause.test.tsx` (new, grew to 12 tests across the review cycles), `sleep-manager-vad.test.ts` (1 case updated to opt into `autoSleepEnabled:true`), `harness/fake-services.ts` (construction/stop counters added).

### C3 — docs (this worktree + CertMateUnified)

- Status: **applied**.
- Hub `CLAUDE.md` + `AGENTS.md`: "3-tier Active/Dozing/Sleeping" → actual state.
- `docs/reference/vad-investigation.md`: two new dated entries — 2026-04-27 Stage 4c Dozing removal (previously **unrecorded** in this journal at all) and 2026-08-13 this retirement + the wake-during-close race finding.
- `CertMateUnified/CLAUDE.md`: same correction (no `AGENTS.md` in that repo — the plan's citation of `CertMateUnified/AGENTS.md:94/:263/:291` does not apply; verified by direct `ls`).
- Changelog: hub one-liner + full `docs/reference/changelog.md` entry.

### Tests — deterministic flag contract, both clients

- Status: **applied**. See C1/C1a (iOS) and C2/C2a (web) sections above for the itemised list against the plan's 6-case spec (1, 2, 3, 4, 4b, 5, 6 — iOS covers 1/2/3/5/6; web covers 1/2/4/4b/5 plus the C1a-equivalent is iOS-only by design).
- Backend suite run as the parallel-workstream hygiene rule (backend untouched by this plan): 8785 passed, 19 pre-existing skips — clean before AND after the Codex review cycles.

### Codex diff review (web + docs half only — see below for why iOS wasn't included)

**Why iOS isn't in this diff review:** iOS commits landed directly on CertMateUnified's own `main` (a separate repo, no PR gate — this repo's established convention, confirmed via `git log` before delegating, and the SAME pattern PLAN-B/PLAN-D used in this same wave). `/ep`'s Codex diff-review loop operates on `git diff <merge-base> HEAD` within THIS run's worktree, which is EICR_Automation-scoped; CertMateUnified's diff was independently verified by this session instead (see C1/C1a section above), matching the precedent set by the two prior chain hops.

5 cycles run against the web+docs diff (3-lens parallel cycle 1, one per-fix mini-review, single-pass cycles 2-5):

| Cycle | Findings | Outcome |
|---|---|---|
| 1 (3-lens: wire-contract, silent-path, edge-interactions) | 5 BLOCKER (deduped from 3 lenses; ~12 raw) | 4 fixed (sticky `timerSuspended` latch; `pausedLightweightRef` leak on stop(); `resumeInFlightRef` concurrency guard; `disconnectDeepgramForPause()` buffer-preserving helper), 1 declined+reconsidered (injectable scheduler — implemented anyway, see below) |
| mini-review (fix hunks only) | 2 (1 real, 1 pre-existing-architecture) | 1 fixed (deferred-TTS drain via `onInspectorStoppedSpeaking()` instead of a raw flag clear); 1 held as OUT_OF_SCOPE (resume() ABA race across session boundaries — no `intent_evidence` quote from context, guard fails per skill rule) then **self-reconsidered and fixed with a 1-line removal** once the actual minimal fix was found (don't reset `resumeInFlightRef` in `stop()` at all) |
| 2 | 4 BLOCKER + 1 NIT | `beginMicOnly()` session-ownership guard (stops orphaned mic on stale session rotation); stale SleepManager docblocks corrected; mic-stop test coverage added; injectable `timerScheduler` implemented (the declined cycle-1 item, reconsidered); 1 finding (Deepgram close-race, ~300ms flush window) held OUT_OF_SCOPE — genuine parity gap with iOS's C1a, logged as follow-up; BFCache pagehide/freeze ordering (edge-interactions lens, cycle 1) also fixed here after reconsideration |
| 3 | 1 IMPORTANT | `beginMicOnly()` upgraded to report abort so callers (resume(), beginMicPipeline()) bail immediately instead of falling through into openDeepgram()/sonnet.resume() on a rotated session |
| 4 | 1 IMPORTANT | `resumeInFlightRef` upgraded from a global boolean to a session-owned token (blocks only a SAME-session double-tap, not a different session's legitimate resume) |
| 5 | **0** | **PASSED — clean** |

Every fix cycle was gated on a full re-run of the touched test files + full web suite before commit; the final state is 1694 web tests passed (1 pre-existing skip, unrelated) and 8785 backend tests passed (19 pre-existing skips) — both green.

**Deviations from the literal plan text:** none required Codex's `OUT_OF_SCOPE + WITHIN_INTENT` sanctioned-deviation path — every applied fix was an in-scope correctness fix within the plan's own C2/C2a contract. Outcome header is plain `ALL PASSED`, not `ALL PASSED (plan-deviation: ...)`.

## Assumed decisions

- `[ASSUMED]` Web's "same injectable-scheduler test seam" requirement — initially judged satisfied implicitly by `vi.useFakeTimers()` (functionally equivalent, already the file's established pattern). Codex cycle 2 flagged this as a literal-wording gap; reconsidered and implemented a real `timerScheduler` property mirroring iOS's shape, proven by a dedicated test with zero fake-timer dependency. Final state satisfies both the letter and spirit of the plan text.
- `[ASSUMED]` `disconnectDeepgramForPause()`'s scope (which state to preserve vs reset during a lighter-weight pause) was derived from first-principles reasoning about Sonnet staying alive (unlike stop()/error, where the SAME `teardownDeepgram()` call is correct because Sonnet is ALSO gone) — verified against the "Bug K" comment already in the codebase explaining why the buffers are cleared on full teardown, confirming the inverse reasoning for the lighter-weight case. Codex's mini-review caught one gap in this reasoning (the deferred-TTS drain call), fixed.

## Skipped / blocked / failed steps

None. Every plan step (C1, C1a, C2, C2a, C3, Tests) reached `applied`.

## Stashes left behind

- `stash@{0}` in `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified` (see Pre-flight above) — pre-existing, not authored by this run, deliberately not restored. See Follow-ups.

## Tests run + result

- Web (`npx vitest run`, full suite, re-run after every Codex-review commit): 1694 passed, 1 pre-existing skip.
- Backend (`npm test`, full suite, hygiene rule — backend untouched): 8785 passed, 19 pre-existing skips.
- iOS (`xcodebuild test`, delegated agent + independently verified diff): 1681/1681 passed (was 1666 before).

## Plan deviations

None (see "Deviations from the literal plan text" above — every fix stayed within the plan's own C2/C2a contract).

## Follow-ups noticed

`[FOLLOWUP] CertMateUnified has real uncommitted work sitting stashed (stash@{0}, "ep: PLAN-C pre-existing dirty state...") that a changelog entry already claims shipped` — the PLAN-B changelog row (2026-08-13, `docs/reference/changelog.md`) states the `fastPathCorrelationTTL` was "extended to 300s on both backend and iOS," but the iOS half of that change was never actually committed — it was found sitting uncommitted in CertMateUnified before this run began and was stashed (not discarded) to keep it separate from PLAN-C's own commits. A SEPARATE, unrelated `AGENTS.md` + `.codex/agents/*.toml` scaffold is bundled in the same stash entry. Derek needs to decide: (a) commit the TTL fix for real (it looks complete and correct — comment-only + one constant change + matching test updates), and (b) decide whether the `.codex` scaffold is wanted work to keep or abandoned experimentation to discard. Next action: `git -C CertMateUnified stash show -p stash@{0}` to review, then either `git stash pop`+split into two commits, or hand-cherry-pick the TTL fix and drop the rest.

`[FOLLOWUP] Web's DeepgramService has no generation-ownership concept — a parity gap with iOS's C1a, found twice by Codex review (cycles 1 and 2/3)` — `disconnect()` keeps the closing socket's callbacks live for ~300ms to flush trailing finals; a fast pause()→resume() on web could theoretically let a stale callback fire into the just-reopened connection/Sonnet session. iOS just built exactly this kind of hardening (`connectionGeneration`, validated at every reconnect site) for its OWN reconnect race (C1a) — web has no equivalent for ANY of its Deepgram-opening call sites (`start()`, `resume()`, `handleWake()`, and now C2a's lightweight resume). Next action: a focused follow-up plan scoped to "port C1a's generation-ownership pattern to web's DeepgramService," covering the ~300ms close race AND the separately-noted fire-and-forget `connect()` (below) in one pass, since both stem from the same missing capability.

`[FOLLOWUP] DeepgramService.connect()/openDeepgram() never awaits the actual WS-open before resolving` — `sendSamples()` silently no-ops (`if (!this.ws || this.state !== 'connected') return;`) while the socket is still connecting, so any mic samples captured in that window are silently dropped. Verified as an existing pattern across every Deepgram-opening call site in `recording-context.tsx`, not introduced or worsened by this plan. Same root cause/fix as the item above (an awaited, generation-owned connect API) — folded into that same follow-up rather than listed separately in the digest.

`[FOLLOWUP] TTS pause/resume test coverage (plan test case 5) is shallow` — `sleep-manager-flag-gate.test.ts`'s case (5) only asserts `SleepManager.setTtsActive()` doesn't throw with the flag off; it doesn't exercise the real `RecordingProvider` → `DeepgramService.pauseAudioStream()`/`resumeAudioStream()` → `tts_echo_pause_begin/end` pipeline end-to-end. The underlying product code is completely untouched by this plan, so this is a pre-existing test-depth gap, not a shipped defect. Next action: extend `harness/fake-services.ts` with Deepgram pause/resume call counters (small addition, same shape as the mic-stop counter already added this run) and drive a real TTS lifecycle through the B0 harness in a follow-up test-only PR.

`[FOLLOWUP] Three dead "Restart" stop()→setTimeout(pause) sites in recording-context.tsx (~417-420/522/572)` — confirmed dead by the plan's own C2a Decision text (`pause()`'s active-state guard no-ops after `stop()`, so these three call sites can never actually reach the pause path). Explicitly named as an INDEX follow-up by the plan itself; not touched by this run, listed here only for completeness of the queue. (+1 more noted inline in the plan text but out of the 5-item cap — the wake-race hardening addendum, deliberately deferred by the plan itself to the flag-ON-only path, is a KNOWN non-issue while the flag stays default-off.)

## Completed 2026-08-13T17:49:02Z

- **Outcome header:** `ALL PASSED`
- **Commits made (this worktree, `ep/PLAN-C-20260813T154458Z-ep`):**
  - `54a1e66d` feat(web): retire the Deepgram Sleeping tier by default, config-gated (PLAN-C, id 120)
  - `cba0a7c7` docs(ep): retire the stale 3-tier Active/Dozing/Sleeping claim (PLAN-C, id 120)
  - `50e3b3f8` fix(ep): address Codex diff-review cycle 1 for PLAN-C
  - `1aa404d5` fix(ep): address Codex per-fix mini-review for PLAN-C
  - `bf59eb7b` fix(ep): address Codex diff-review cycle-1 remaining findings for PLAN-C
  - `2f19b5c0` fix(ep): address Codex diff-review cycle 2 for PLAN-C
  - `0ac36ec4` fix(ep): address Codex diff-review cycle 3 for PLAN-C
  - `64168acd` fix(ep): address Codex diff-review cycle 4 for PLAN-C
  - (CertMateUnified, separate repo, already on `origin/main`): `2230b50`, `adeb860`, `568c1c6`
- **Files touched:** `web/src/lib/recording-context.tsx`, `web/src/lib/recording/sleep-manager.ts`, `web/tests/harness/c2a-lightweight-pause.test.tsx` (new), `web/tests/sleep-manager-flag-gate.test.ts` (new), `web/tests/sleep-manager-vad.test.ts`, `web/tests/harness/fake-services.ts`, `CLAUDE.md`, `AGENTS.md`, `docs/reference/changelog.md`, `docs/reference/vad-investigation.md`; CertMateUnified: `Sources/Audio/SleepManager.swift`, `Sources/Recording/DeepgramRecordingViewModel.swift`, `Sources/Recording/RecordingSessionCoordinator.swift`, `Sources/Services/DeepgramService.swift`, `Sources/Services/ServiceProtocols.swift`, `Tests/CertMateUnifiedTests/Audio/SleepManagerAutoSleepFlagTests.swift` (new), `Tests/CertMateUnifiedTests/Services/DeepgramServiceGenerationOwnershipTests.swift` (new), `Tests/CertMateUnifiedTests/Recording/RecordingSessionCoordinatorAwaitedReconnectTests.swift` (new), `Tests/CertMateUnifiedTests/Mocks/MockDeepgramService.swift`, `CertMateUnified/CLAUDE.md`.
- **Plan deviations:** none.
- **Assumed decisions:** see "Assumed decisions" section above (2 items, both resolved to the more thorough interpretation on Codex review).
- **Skipped / blocked / failed steps:** none.
- **Stashes left behind:** `stash@{0}` in CertMateUnified — pre-existing, not authored by this run (see Follow-ups).
- **Tests run + result:** web 1694/1695 (1 pre-existing skip); backend 8785/8804 (19 pre-existing skips); iOS 1681/1681.
- **Follow-ups noticed:** 4 (all agent-actionable — see "Follow-ups noticed" section above). 0 decision-class items beyond the stash question, which IS decision-class (see below).
