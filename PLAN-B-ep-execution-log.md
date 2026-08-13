# PLAN-B execution log

- Session: `20260813T064528Z-ep`
- Worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260813T064528Z-ep`
- Branch: `ep/PLAN-B-20260813T064528Z-ep`
- Base: `main` @ `fa3905b1` (includes PLAN-A/A2/D/E merges) — verified unchanged (`origin/main` still `fa3905b1`) immediately before merge
- Chain hop: 4 (`--chain --chain-hop=4`)

## Pre-flight

- `ep-reap.sh sweep`: reaped=0 held=0 working=1 — no stranded sessions, no action needed.
- Plan-size check: PLAN-B spans backend (B1.2/B1.3/B3: 5 files) + iOS (B1.1/B1.4/B2: 3+ files) + web (B3 companion: 1 file). 3 distinct feature groups touching one high-interaction subsystem (fast-path TTS/confirmation dedupe) — over the ~8-item/3-group split heuristic. Logged `[PLAN-SIZE]` warning per rule; proceeded since `/rp` already converged 0/0 across 7 rounds.
- Used shared `PLAN-conversation-context.md` (wave-level, covers PLAN-A..F) — no PLAN-B-specific context sibling.
- Refine log: 7 rounds, both reviewers CLEAN at round 7. Round 1 found the EVIDENCE.md M1 dossier claim FALSE on main (correlation threading never existed on iOS) and rewrote B1 wholesale — treated as settled per the plan header.
- No "Skipped (ambiguous fix)" entries in the refine log.

## [PLAN-SIZE] warning

This plan bundles 3 feature groups (B1 wire hop, B2 iOS state machine, B3 backend orphan net) across 3 codebases. Proceeding as directed; expect a long Codex convergence per the hub's calibration note — this run's actual convergence (6 review cycles, 28 real defects found and fixed) confirms that calibration was accurate for this plan's shape.

## Implementation

### B1.2/B1.3/B3 — backend (this worktree)

Delegated to a dedicated background agent with a brief built from direct exploration of the existing correlation infrastructure (`voice-latency-turn-summary.js`'s `correlationToTurn`/`fastPathCorrelationIdByTurn`, `voice-latency-fast-tts.js`'s `onAudio` callback, `stage6-shadow-harness.js`'s turn-entry correlation seeding and `bundleToolCallsIntoResult` call sites). New module `src/extraction/fast-path-accepted-identity.js` — a combined TTL-scoped accepted-identity (B1.2) + fast-attempt ledger (B3.1) record per correlationId. Verified independently: full backend suite green (8698/8698) before any Codex review.

### B3.2 dedupe-token key builders (this worktree, done first, standalone)

`duplicate_<turnId>` prefix branch added to all three backend key builders in `ios-dedupe-key.js`, checked BEFORE the existing `WIRE_CLIENT_DEDUPE_TOKEN_FIELDS` allowlist — a structurally separate branch, not an allowlist addition (would reopen the id-84 correction-swallow fix). 38 tests, all passing.

### Web companion

`web/src/lib/recording/confirmation-dedupe-key.ts` gained the identical `duplicate_` prefix branch; `sonnet-session.ts`'s `Confirmation` type declares `fast_correlation_id` for decode honesty (web tolerates/ignores it — no fast-TTS path). 7 new contract tests. Full web suite green (1677/1677) before Codex review.

### B1.1/B1.4/B2 — iOS (CertMateUnified, separate repo)

Delegated to a background agent working directly on CertMateUnified's `main` (this repo's own convention — direct-to-main, no PR gate, confirmed via `git log` before delegating). 4 commits, auto-pushed to `origin/main` by a pre-existing `post-commit` hook (`nohup git push origin main &`) — the agent never ran `git push` itself; this is the SAME behavior PLAN-D's D2 work exhibited, confirmed as this repo's established pattern, not a violation. Independently verified: `HEAD` matches `origin/main`, working tree clean, 1666 tests green (47 new), and direct review of the diff (mismatch pre-scan, correlation state machine, slot-key fallback) confirmed faithful, careful implementation matching the plan's exact subtleties (member-by-member grouped pre-scan, `slotKey: nil` bypass routing through the shared dispatch helper, the dedupe-precedence-vs-ordinary-gate fix). The agent's own testing caught and fixed two real bugs before shipping (a force-unwrap crash newly reachable via the bypass path; a TTL-clock test/production clock inconsistency).

## Codex diff review (`gpt-5.6-sol`, high effort) — 6 cycles, 28 defects found and fixed

**Note on rate-limit false alarm:** the FIRST attempt at cycle 1 hit `ask-codex` "Rate Limit Exceeded" on every call for ~2.5h of real waiting (following the documented wait-and-retry recovery faithfully). Root cause, confirmed independently: the `outputSchema` built for the call was missing `additionalProperties: false` on its object nodes — OpenAI's strict schema mode rejects that outright, and the MCP wrapper reports the resulting validation error using the exact same string as a genuine rate limit. Fixed the schema (added `additionalProperties: false` to both object nodes); the very next call succeeded immediately. This is now documented in both `/ep`'s and `/rp`'s command files (`dev-tooling/claude/commands/{ep,rp}.md`, commit `e0cc9cc`) plus a new memory (`reference_codex_outputschema_additionalproperties`) so no future session loses hours to the same false diagnosis.

- **Cycle 1** (3 parallel lenses — wire-contract faithfulness, silent-path hunt, edge interactions): 8 distinct findings after merge/dedupe (F1-F9, one dropped for redundancy) — echo-join used raw wire `board_id` instead of the effective board (reproducing the exact double-read-back bug); the pending fallback silently defaulted to absence before the fast route's first `onAudio` byte instead of the plan's required "pending, not absence"; the exact-duplicate check ignored board scope; a duplicate-detection ordering bug silently changed the untouched `allRejected` recovery path; ledger records weren't session-scoped; `identityCommitted` could flip true on an empty/skipped write; missing mandatory parity-ledger documentation; two sanctioned deviations (F8: per-correlation outcomes instead of a turn-wide single winner; F9: TTL raised past the extraction watchdog ceiling) — both WITHIN_INTENT per the Audio-First invariant, applied and logged as `[DEVIATION]`.
- **Per-fix mini-review** (fix hunks only): 4 more IMPORTANT + 1 NIT — asymmetric board normalization on the commit side; the pending-uncommitted fallback dropped the clamp-correction clause; session-scoping only covered readers, not writers; per-correlation outcomes could still double-speak a semantically-identical retry; a stale TTL comment.
- **Cycle 2**: 6 more — most severely, **two literal NUL bytes** had been accidentally written into template-literal sentinel keys by the mini-review's coalescing fix, making `stage6-shadow-harness.js` and `stage6-event-bundler.js` register as BINARY to `git`/`grep`/`rg` for the remainder of the session (this explained several mysterious empty-grep results earlier in this run); plus mixed-state outcomes could still silently drop a sibling reading; further board-scope gaps; an inverted test + missing required concurrency/egress tests; missing `ios-pipeline.md` documentation.
- **Cycle 3**: 3 BLOCKERs — an ask-answer transcript never seeded its fast-dispatch correlation onto the resumed turn (recreating the double-read-back for that class of turn); the committed-pending fallback still dropped the correction clause in a second spot; a WS-before-HTTP race where NO comparison content could be recovered could still produce an uncoordinated apology + fast clip. The third was Codex's own proposed fix (a bounded synchronous wait + tombstone + reject-late mechanism) — judged to be a new architectural mechanism beyond the plan's scope; implemented a narrower, more conservative mitigation instead (suppress the generic apology, don't invent a wait), logged as a deliberate scope-narrowing (not a plan deviation — no new spoken behavior was added, only a silence substituted for a risky apology).
- **Cycle 4**: 1 BLOCKER + 2 IMPORTANT — the pre-existing marker-② catch-all apology mechanism (from an earlier 2026-07-18 wave) wasn't told about B3/D3's deliberate silences, so it fired its own apology on top, defeating the suppression entirely — fixed with a turn-scoped latch threaded into marker-②'s `noSpeechIntent` predicate; the ask-answer correlation merge didn't roll back on a losing race; the B3.2 exact-duplicate path independently dropped the correction clause (third occurrence of the same bug class).
- **Cycle 5**: 0 BLOCKER, 2 IMPORTANT (first cycle with no BLOCKER — convergence signal) — B3 was accidentally nested inside the unrelated legacy `ORPHAN_PROMPT_ENABLED` kill switch (same class as cycle-1's F4, different flag); the separate Plan 00 evaluation/evidence harness didn't bind the array-shaped correlation id or ask-answer correlations (evaluation-telemetry accuracy only — production audible behavior was already correct).
- **Cycle 6**: **CLEAN — zero findings.** Diff review PASSES.

Every cycle's diff was re-gated against the full backend + web suites before the next cycle; every cycle ended green. Final: backend 8785/8785 (19 pre-existing skips), web 1677/1677 (1 pre-existing skip).

## Completed

**Outcome: ALL PASSED (plan-deviation: 3 applied within original intent — F8, F9, and the cycle-3 D3 scope-narrowing).**

- **Commits**: 36 total on `ep/PLAN-B-20260813T064528Z-ep` (backend/web implementation + fixes; iOS commits are on CertMateUnified's own `main`, separate repo, already verified live).
- **Files touched (backend)**: `src/extraction/fast-path-accepted-identity.js` (new), `src/extraction/stage6-event-bundler.js`, `src/extraction/stage6-shadow-harness.js`, `src/extraction/sonnet-stream.js`, `src/routes/voice-latency-fast-tts.js`, `src/routes/voice-latency-playback-ack.js`, `src/extraction/ios-dedupe-key.js`, `docs/reference/ios-pipeline.md`, `docs/reference/changelog.md`, `CLAUDE.md`, `scripts/model-ab/plan00-expectation-manifest.json`, plus ~20 test files (new + updated).
- **Files touched (web)**: `web/src/lib/recording/confirmation-dedupe-key.ts`, `web/src/lib/recording/sonnet-session.ts`, `web/docs/parity-ledger.md`, `web/tests/confirmation-dedupe-key.test.ts`.
- **Files touched (iOS, CertMateUnified, separate repo)**: `Sources/Recording/AlertManager.swift`, `Sources/Recording/DeepgramRecordingViewModel.swift`, `Sources/Services/ServerWebSocketService.swift`, `Sources/Services/ServerWebSocketServiceProtocol.swift`, `Sources/Services/ClaudeService.swift`, `Sources/Services/ServiceProtocols.swift`, `CLAUDE.md`, plus new/updated test files (47 new tests) — already on `origin/main`.
- **Plan deviations** (sanctioned, WITHIN_INTENT, applied and shipped):
  1. **F8** — `resolveFastLedgerOutcomeForTurn` returns an array of per-correlation outcomes (coalesced by semantic slot+value+correction identity) instead of a single turn-wide winner. Plan's literal precedence table didn't cover multiple correlations in one turn; Audio-First invariant #1 ("every dictated reading read back EXACTLY once") affirmatively requires it.
  2. **F9** — `RECORD_TTL_MS` (backend) and `AlertManager.fastPathCorrelationTTL` (iOS) raised from 60s to 300s, safely exceeding `EXTRACTION_WATCHDOG_ABSOLUTE_MS` (~195s) so a legitimately long turn can't lose its fast-attempt bookkeeping mid-turn. Same invariant.
  3. **Cycle-3 D3 scope-narrowing** — implemented a conservative "suppress the generic apology" mitigation for the WS-before-HTTP unrecoverable-content race, explicitly declining Codex's own larger proposed mechanism (bounded wait + tombstone + reject-late) as beyond plan scope. Not a new spoken behavior — a silence substituted for a risky apology.
- **Assumed decisions**: none beyond the sanctioned deviations above — every other Codex finding across 6 cycles had a concrete, in-scope, mechanical fix.
- **Skipped/blocked/failed steps**: none.
- **Stashes left behind**: none.
- **Tests run + result**: backend Jest 8785 passed / 19 skipped / 0 failed (346/347 suites); web Vitest 1677 passed / 1 skipped / 0 failed (153/154 files); iOS `xcodebuild test` 1666 passed / 0 failed (separate repo, already verified).
- **Follow-ups noticed**: none beyond what's already captured as `[DEVIATION]`/fixed above — this run's own review process (6 cycles) was thorough enough that nothing was knowingly left unaddressed within scope.
