# Execution log — web-tts-fifo-parity (Phase 7.1 → web)

- Session: `20260706T110501Z-ep`
- Started: 2026-07-06T11:05Z
- Repo: `/Users/derekbeckley/Developer/EICR_Automation`
- Worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260706T110501Z-ep`
- Branch: `ep/PLAN-20260706T110501Z-ep`
- Plan: `PLAN-final.md` (10-round two-reviewer convergence, zero skipped fixes)
- Note: supersedes an aborted 06:11Z stub run (never created a worktree; predated the 09:25Z finalized plan).

## Steps

Every plan step executed VERBATIM (ambiguity-ladder rule 1) — zero skipped, zero blocked, zero failed. The plan was exceptionally prescriptive (10 rounds, two reviewers, zero "Skipped (ambiguous fix)"), so no local interpretation was needed beyond the two `[ASSUMED]` notes below.

### §3.1 — `web/src/lib/recording/tts-queue.ts` (NEW) + `prepareElevenLabs`
- Status: applied. Commit `f8261299`.
- Built the framework-free confirmation FIFO exactly to spec: injected per-call player (no circular import), `startedPlayback` flag, last-mile deferral gate (re-check post-fetch/pre-`audio.play()`), drop-oldest overflow, `preemptFlush`/`purge`/`reset`/`resumeIfDeferred`, synchronous `onDiscarded`, id-guarded `completeHead`, gate default `() => false`.
- Added `prepareElevenLabs` to `elevenlabs-tts.ts` (fetch/play split for the last-mile gate). `speakElevenLabs` LEFT UNCHANGED for the direct path (its 20 tests stay green).
- **[ASSUMED] step §3.1 overflow depth** — the plan's §4 test says "enqueue 7 → oldest dropped, discardedCount 1". Chose `MAX_QUEUE_DEPTH=6` counting head+queue (total pending), so the 7th enqueue behind a busy head triggers exactly one drop-oldest. iOS's exact off-by-one on whether the playing item counts isn't field-observable; this interpretation is the one that satisfies the plan's assertion. Documented in the module docstring.

### §3.2 — `tts.ts` two-path rewire
- Status: applied. Commit `03499668`.
- `speakConfirmation`→FIFO enqueue via thin player; `speak()`→`preemptFlush()` then direct `dispatch`; token-guarded `activeAudioOwner`; `cancelSpeech(opts)` (reset-first on teardown, owner-gated selective cancel on barge-in, both backends); `dispatchNative` fires `onStart`+`onError`; misleading doc comment rewritten; `SpeakOptions` exported+widened; `isDirectAudioActive()` getter; `dispatchElevenLabs` aborted branch now fires `onError('aborted')`.

### §3.3a/§3.3c — `sonnet-session.ts` + `in-flight-question.ts`
- Status: applied. Commit `58cd17d7`.
- `onCancelPendingTts` callback (`{prefix, sessionId?}` shape pinned), guarded `case 'cancel_pending_tts'` (ignores empty prefix), `clearInFlightToolCallIdByPrefix`; `removeByToolCallIdPrefix` on the tracker.

### §3.3 — `recording-context.tsx` + `tts-prompt-helpers.ts` (NEW)
- Status: applied. Commit `98d2e9b5`.
- `speak` wrapper forwards `SpeakOptions`; `speakDirectPrompt` (ONE dispatch site, ref/token, clears-then-resumes); shared `handleInspectorStoppedSpeaking` called from BOTH `onUtteranceEnd` and the phantom `speechConfirmTimer` reset; `setShouldDeferPlayback`/`setOnDiscarded` registered at session open; dedupeKey threaded into `speakConfirmation`; barge-in → `cancelSpeech({resetQueue:false})`; immediate onQuestion prompt → `speakDirectPrompt`; `handleCancelPendingTts` wired via `openSonnet`.
- **[ASSUMED] step §3.3e placement** — the plan offered two seams (pure helpers OR a provider harness) and named pure helpers as preferred. Extracted `handleInspectorStoppedSpeaking` + `handleCancelPendingTts` into `tts-prompt-helpers.ts` (importable, unit-tested directly). Also added `speakDirectPrompt` to `openSonnet`'s dep array to keep `react-hooks/exhaustive-deps` at zero new warnings.

### §3.5 — tour
- Status: applied (no code change needed). `use-tour.ts` already calls `cancelSpeech()` with the default `resetQueue:true` at all six step-change/skip/close sites; the tour runs outside a session so the queue is empty — verified. Regression test added (§4.4).

### §4 — tests
- Status: applied. Commits `d65742ad` + `5efc2c73` (typecheck fix).
- New: `tts-queue.test.ts` (16), `tts-prompt-helpers.test.ts` (10), `tts-fifo-confirmation.test.ts` (serial-through-`speakConfirmation` + tour regression). Extended: `sonnet-session.test.ts` (decode), `in-flight-question.test.ts` (prefix removal), `phase-8-tts.test.ts` (queue `__resetForTests` in beforeEach — the shim never fires `onend` so a head would leak). Direct-path/primitive cancel tests KEPT (not inverted), per the plan's IMPORTANT.
- Post-commit `tsc --noEmit` caught that untyped `vi.fn()` mocks didn't match the typed `CancelPendingTtsDeps` params → typed each with `vi.fn<Sig>()` (codebase idiom), amended in `5efc2c73`.

### §5 — docs
- Status: applied. Commit `6913a048`.
- `parity-ledger.md`: `recording/tts-fifo`→`match` (2026-07-06); new `recording/cancel-pending-tts`→`match`; WS3 recording-context + fast-path rows refreshed. `parity-ledger-files.json`: +tts-queue.ts, +tts-prompt-helpers.ts, +cancel-pending-tts on recording-context/sonnet-session/in-flight. Changelog row added to `docs/reference/changelog.md` (full) + `CLAUDE.md` + `AGENTS.md` (one-line) — the docs-only scope exception.

## Completed 2026-07-06T12:52Z

- **Outcome: ALL PASSED** — every plan step applied (2 `[ASSUMED]`, both documented above; 0 skipped / 0 blocked / 0 failed).
- **Commits** (7): `f8261299` FIFO queue + ElevenLabs fetch/play split · `03499668` two-path TTS · `58cd17d7` cancel_pending_tts decode + state-clear · `98d2e9b5` provider wiring · `d65742ad` tests · `5efc2c73` typecheck fix (typed mocks) · `6913a048` docs. Plus the execution-log commit.
- **Files touched**: `web/src/lib/recording/{tts-queue,tts-prompt-helpers}.ts` (new), `web/src/lib/recording/{tts,elevenlabs-tts,sonnet-session,in-flight-question}.ts`, `web/src/lib/recording-context.tsx`, `web/tests/{tts-queue,tts-prompt-helpers,tts-fifo-confirmation}.test.ts` (new), `web/tests/{phase-8-tts,sonnet-session,in-flight-question}.test.ts`, `web/docs/parity-ledger.md`, `web/docs/parity-ledger-files.json`, hub `CLAUDE.md`/`AGENTS.md`, `docs/reference/changelog.md`.
- **Assumed decisions**: (1) overflow depth counts head+queue so 7 enqueues drop the oldest (satisfies the plan's §4 test); (2) pure-helper seam chosen over provider harness (plan-preferred).
- **Skipped / blocked / failed**: none.
- **Stashes left behind**: none.
- **Tests run + result**: full web suite `1362 passed` (parallel AND `--no-file-parallelism` serial); `tsc --noEmit` clean for all changed files (only 2 pre-existing baseline test files remain, unchanged from main); eslint zero new problems. Backend untouched.
- **Deploy**: gate ALL PASSED + REPO_ROOT=EICR_Automation → web-only frontend deploy (ECS `eicr-pwa` via CI). No iOS changes → no TestFlight.

