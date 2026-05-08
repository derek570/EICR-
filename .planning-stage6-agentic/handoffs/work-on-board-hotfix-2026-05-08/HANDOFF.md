# Autonomous-Execution Handoff — "Work on Board" Hotfix

**Read this first.** You are a fresh Claude session being handed an unattended overnight task. Derek is asleep. You will execute the hotfix plan autonomously, slice by slice, until you hit either:

1. A successful end state (slices 1-5 shipped, CI green on backend, iOS commits on local main, ready for Derek's slice-6 field test in the morning), OR
2. A stop condition listed at the bottom of this document.

In either case, write a status update to `STATUS.md` in this same directory before exiting.

---

## TL;DR

The "Work on Board" sprint (Phases A-E) shipped to `main` on both repos earlier today. A post-sprint code review (Claude + Codex, 2 rounds each) found **2 BLOCKERs and 6 IMPORTANTs**. The full hotfix plan is in sibling `PLAN.md` (572 lines, v3). It closes all 10 findings across 6 slices.

You are executing slices 1 through 5 (slice 6 is a real-iPad field test — Derek does that, not you). Slice 1 is the data-correctness gate; slices 2-3 close the broadcast/error contract; slices 4-5 close the remaining IMPORTANTs and the LiveFillView NIT.

If you only read one file: **`PLAN.md`** in this directory. Everything else here is procedural — PLAN.md has the technical specifications.

---

## Working directories + base state

```bash
BACKEND=/Users/derekbeckley/Developer/EICR_Automation
IOS=/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified
```

Both are git repos. iOS is nested inside backend's path but has its own `.git`.

**Base state verification (run this first):**

```bash
cd $BACKEND && git log --oneline -3
# Expected top: c0b7e32 docs(stage6): hotfix plan for the 10 review findings (v3)
#               4973d05 docs(stage6): session handoff — Work on Board Phases D + E shipped
#               38fbce0 feat(stage6): Phase E backend — unified current_board_changed broadcast

cd $IOS && git log --oneline -1
# Expected: 0849da1 feat(stage6): Phase D + E iOS — current_board_changed + red banner

cd $BACKEND && git status --short
# Untracked allowed: .planning-stage6-agentic/handoffs/2026-04-21-*.md, scripts/ccu-cv-corpus/debug-*, etc.
# Modified: NONE.

cd $IOS && git status --short
# Modified allowed: Sources/Info.plist (build number bump, ignore).
# Untracked allowed: .claude/scheduled_tasks.lock.
```

If base state doesn't match, **STOP** and write to STATUS.md.

---

## Execution loop

Each slice has the same shape:

1. **Read** the slice section in PLAN.md.
2. **Implement** sub-slice by sub-slice — never skip ahead, never combine sub-slices in one commit.
3. **Test:**
   - Backend: `cd $BACKEND && node --experimental-vm-modules node_modules/jest/bin/jest.js --testPathPattern='<targeted>' --no-coverage`
   - iOS: Mac Catalyst (iPhone simulator unavailable on this Mac):
     ```bash
     cd $IOS && xcodebuild -scheme CertMateUnified \
       -destination 'platform=macOS,variant=Mac Catalyst' \
       -only-testing:CertMateUnifiedTests/<TestClass> \
       CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO test
     ```
4. **Commit per sub-slice** with detailed message (CLAUDE.md auto-commit rule).
5. **At slice boundary:** run the full backend suite (`npm test --silent` from $BACKEND) + the relevant iOS test classes. Both must be green before moving to next slice.
6. **At gate boundary** (after slice 3): push backend to `origin/main` so CI deploys. Wait for CI to settle (use `gh run watch <run-id> --exit-status` — single long-poll, no polling loop).
7. **At slice 5 completion:** push iOS to origin (Derek wants TestFlight done manually; just push so the commits are visible on GitHub).

---

## Slice-by-slice procedural notes

### Slice 1 — Board-scoped reading round-trip (THE GATE)

**Critical path. ~1.5 sessions of work in PLAN.md but autonomous execution may take longer with verification.** Do every sub-slice in order:

- **1.1a** bundler emits board_id → commit
- **1.1b** shadow-harness folds preserve board_id → commit
- **1.1c** per-turn accumulator collision keys → commit (this is the trickiest — the encoding spec in PLAN.md is exact, follow it verbatim)
- **1.2** iOS Codable additions → commit
- **1.3** iOS apply path routing (incl. correction path lines ~5616/5727 + board-level field branches) → commit
- **1.3b** AudioImportViewModel parallel fix → commit (if slice 1 is already past 1.5 sessions, defer per PLAN.md and note in STATUS.md)
- **1.4** iOS jobState carries hierarchy fields → commit
- **1.5** ALL the tests listed in the slice — these are the safety net. Run them and confirm green before moving on.

**Acceptance check after slice 1:** the EEB8F9EA round-trip regression test passes on both backend (shadow-harness level) and iOS (DeepgramRecordingViewModelTests).

**If you hit:**
- A pre-existing test that locks the OLD wire shape (no board_id), update it to the NEW shape and document in the commit message that it was a fixture update, not a behaviour regression.
- A SwiftUI compile error around `@Observable` actor boundaries, re-read PLAN.md slice 1.3 actor-boundary note. Both view models are `@MainActor`; access patterns mirror existing Phase E code.
- A test failure you can't diagnose in 2 build cycles, **STOP** and write to STATUS.md.

### Slice 2 — Broadcast completeness

Backend-only. Single commit per sub-slice (2.1 widen helper, 2.2 flush scan, 2.3 session_start/resume initial broadcast). Tests in slice 2.4 — extend `src/__tests__/sonnet-stream-select-board.test.js`.

**Ordering tests are critical.** Use the existing fake-WS `_sent` array to assert envelope order: `session_started` ack → `current_board_changed`. Codex confirmed in v2 review this is testable in the existing harness.

### Slice 3 — Validation + ack failure

Backend half:

- Swap `validateRecordReading || validateBoardScope` → `validateBoardScope || validateRecordReading` in all 5 dispatchers + `record_board_reading` (grep for the pattern). Some pre-existing tests will flip from `circuit_not_found` to `wrong_board` — that's correct, update them.

iOS half:

- Override `serverDidReceiveSelectBoardAck` in `DeepgramRecordingViewModel`. On `ok=false`, TTS the human-readable error mapped from `ack.error`. Add a test that exercises the override.

### Slices 4 & 5

Per PLAN.md. Lower risk than 1-3 but DO follow the same per-sub-slice commit + test cadence.

---

## Push protocol

**Backend:**

- Push after slice 3 completes locally + tests green.
- `cd $BACKEND && git push origin main` — pre-push hook will run the full Jest suite. If it fails, fix and re-push (do NOT use `--no-verify`).
- After push: `gh run list --limit 1` to find the run id, then `gh run watch <id> --exit-status`. CI takes ~13-30 min.
- If CI fails: read the failure log, diagnose, fix on local main, push again. DO NOT force-push.
- Push again after slice 4 (dialogue-engine) when complete.

**iOS:**

- Push after slice 5 (LiveFillView) completes + tests green.
- `cd $IOS && git push origin main`. No CI on iOS repo — push just makes commits visible.
- DO NOT bump TestFlight build number. DO NOT run `./deploy-testflight.sh`. Derek does that manually.

---

## Commit message style

Match the existing repo style (multi-line with What/Why/How sections — see recent commits on main). Detailed bodies. Co-author trailer:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

One commit per sub-slice. Group prose into:

1. WHAT changed (brief)
2. WHY (referencing the slice in PLAN.md and the issue # in the closure matrix)
3. WHY THIS APPROACH (the design choices baked into PLAN.md — don't re-derive them, reference them)
4. TESTS added/updated
5. CROSS-REFERENCES (the slice's parent commit + PLAN.md path)

---

## Test discipline

**Pre-existing failing tests** (do NOT confuse with regressions you introduced):

- `JobViewModelTests.testSavePersistsToDatabase`, `testSavePassesCorrectUserId`, `testSaveMarksDirtyForSync` — failing on `main` before the hotfix; unrelated to multi-board work. Skip in your verification cadence.

**Stuck jest processes**: if you see PIDs older than today's date, `pkill -9 -f 'jest|npm test'` and restart. There's a known issue with stale processes from prior sessions on this Mac (see how this happened during Phase E work).

**Mac Catalyst is the only iOS test target available** on this Mac (iPhone 17 Pro simulator isn't installed). Use `-destination 'platform=macOS,variant=Mac Catalyst'`. Some tests may fail spuriously on Mac Catalyst that pass on a real iPad — if you see this, document in STATUS.md but don't block on it.

---

## Stop conditions — when to halt and write STATUS.md

1. **Base state mismatch** — origin/main HEADs don't match expected SHAs.
2. **Test you can't fix in 2 build cycles** — don't loop endlessly. Document the failure and the diagnostic path you tried.
3. **Architectural ambiguity** — if PLAN.md doesn't pin a design choice and you'd need to make a load-bearing call (e.g. "should the helper return null or throw?"), STOP. Don't guess.
4. **CI fails twice in a row** on the same hotfix — diagnose root cause; if you can't, halt.
5. **Slice 1 takes more than 3 hours of wall-clock** — possibly something deeper than expected; halt and let Derek decide.
6. **Anything that requires destructive ops** — force push, branch deletion, tag manipulation, package uninstall. Halt.
7. **You complete slices 1-5 successfully.** Halt at this point — slice 6 is Derek's field test.

In any halt case, write to `STATUS.md` (not memory):

```markdown
# Hotfix Execution Status — <timestamp>

## What's complete
- Slice X: ...
- Slice Y: ...

## Halt reason
<one of the conditions above>

## Diagnostic notes
<what you tried, what you saw, what you suspect>

## Next concrete step Derek should take
<specific action item>
```

---

## What NOT to do

- ❌ Field test (slice 6) — Derek does this on real hardware.
- ❌ TestFlight deploys — Derek runs `./deploy-testflight.sh` manually.
- ❌ Force-push or amend commits already on origin.
- ❌ Skip pre-push hooks.
- ❌ Touch `Sources/Info.plist` build number (it's at 352 from a prior session, pre-existing diff, leave alone).
- ❌ Combine multiple sub-slices into one commit (CLAUDE.md auto-commit rule).
- ❌ Run `git stash` + tests + `git stash pop` — that pattern broke during Phase E work; the test command's exit code can short-circuit the pop. If you need to verify pre-existing failures, just trust the analysis in this handoff (testSave* are pre-existing).
- ❌ `cd <dir>` with shell — use absolute paths via `git -C <dir>` or set the Bash `cwd` argument.

---

## Reference shelf

Read in priority order if context is fresh:

1. **`PLAN.md`** in this directory — authoritative technical spec.
2. `../handoff_2026-05-08_work-on-board-phase-d-e-shipped.md` — what shipped (and what didn't) on Phase E. Provides the "before" state.
3. `../work-on-board-2026-05-08/PLAN.md` — original sprint plan. Useful for understanding why some choices were made (e.g. dual-shape storage rationale).
4. `../handoff_2026-05-08_work-on-board-phase-{a,b,c}-shipped.md` — per-phase rationale + decision logs.
5. `/Users/derekbeckley/Developer/EICR_Automation/CLAUDE.md` — repo-level rules (auto-commit, deploy via CI, etc.).
6. `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/CLAUDE.md` — iOS-repo rules.

If memory was consulted: `MEMORY.md` in `~/.claude/projects/-Users-derekbeckley-Developer-EICR-Automation-CertMateUnified/memory/` has the "Work on Board" sprint pointer + recent decisions.

---

## On finishing

If you reach end-of-slice-5 successfully:

1. Backend on origin/main with slices 1-3 deployed (CI green) and slice 4 pushed (CI green or in flight, document in STATUS.md).
2. iOS on origin/main with slices 1-3, 4 (none on iOS) and 5.
3. Write STATUS.md as a positive completion report:

```markdown
# Hotfix Execution Status — <timestamp> — COMPLETE

## Slices shipped
- Slice 1: <commit hashes, test counts>
- Slice 2: ...
- Slice 3: ...
- Slice 4: ... (or noted as deferred)
- Slice 5: ...

## CI status
- Backend run id: <id>, status: success
- (iOS push only, no CI)

## Field test gate
Ready for Derek's slice 6 field test. Recommended fixture:
- Real iPad
- 2-board job (1 main + 1 sub-1)
- Voice command "work on garage" mid-recording
- Verify CloudWatch `current_board_changed` log rows align with banner UI flips
- Verify post-recording `job.circuits` data: main's circuit 1 unchanged, sub-1's circuit 1 carries the new readings

## Anything notable Derek should know
<surprises, deviations, deferred items>
```

4. Update `MEMORY.md` (the `~/.claude/projects/...` file) — add a one-line entry pointing at the new STATUS.md so the next conversation finds it cleanly.

5. **Do not push iOS** if you're uncertain — leave commits on local `main` and document.

---

## Final reality check before you start

Re-read `PLAN.md` Slice 1.1c (the per-turn key encoding spec) one more time. That's the trickiest piece — Codex caught a BLOCKER there in both review rounds. The NUL-bracketed ` __board__ <boardId> ` tag must be implemented exactly as specified. The decoder edge cases (legacy 2-part keys, `::`-in-boardId rejection, empty-string normalisation, sentinel collision) all need explicit handling.

If anything in Slice 1.1c looks ambiguous to you, **STOP HERE** and write STATUS.md with the ambiguity. Don't make a load-bearing encoding choice on a sleep-deprived solo run.

Good luck. Derek will check progress in the morning.
