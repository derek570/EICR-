# PLAN-E1B2 — /ep execution log

- Session: `20260827T175510Z-ep`
- Started: 2026-08-27T17:55:10Z
- Worktree (REUSED per plan's RESUME INSTRUCTION): `/Users/derekbeckley/Developer/EICR_Automation-ep-20260826T134434Z-ep`
- Branch (REUSED): `ep/PLAN-E1-20260826T134434Z-ep`
- PR (REUSED, draft, will flip to ready on green gate): https://github.com/derek570/EICR-/pull/199

## Setup notes

- Default `/ep` fresh-worktree-per-plan behavior was overridden per the plan's explicit RESUME
  INSTRUCTION. A fresh worktree/branch (`ep/PLAN-E1B2-20260827T175510Z-ep`) was created in error
  at claim time, then removed (`git worktree remove --force`, `git branch -D`) once the resume
  instruction was read — no commits were made on it, so nothing was lost.
- Verified before proceeding: existing worktree HEAD `078da7ce`, clean tree, branch tracking
  `origin/ep/PLAN-E1-20260826T134434Z-ep`; PR #199 open/draft/mergeable.
- Sibling `PLAN-E1B.md` (iOS) already shipped this run's dependency: `.ep-outcome.json` shows
  `ALL PASSED`, CertMateUnified PR #71 merged (`54ff333`). TestFlight submission was NOT run by
  that session (worktree can't code-sign) — flagged there as a decision-class follow-up already.
- [PLAN-SIZE] This plan has 8 fix-spec items (7 JSON findings + 1 branch-introduced typecheck fix)
  spanning a live WebCodecs probe, generation-fencing, and VAD contract widening — high
  interaction-count per the CLAUDE.md warning threshold. Proceeding; full dual-reviewer lane is
  already specified.

## Steps

## Step 7 — fix `poor-signal-advisory.test.ts` TS2774 dead ternary
- Status: applied
- Decision: rule 1 (verbatim). Restores the typecheck baseline to `origin/main`'s true 5 failing files.
- Files: `web/tests/poor-signal-advisory.test.ts`
- Commit: `71f3e1eb`

## Step 1 — Opus encoder completion-signal fix (live probe REQUIRED first)
- Status: applied — **probe resolved to the NON-DETERMINISTIC (disabled) outcome**
- Decision: rule 1. The plan makes the live probe a hard prerequisite and binds items 1/2/4/docs to its result via the outcome matrix. Probe: `scripts/deepgram-webcodecs-opus-packet-probe.mjs` (new), real Chromium 151 `AudioEncoder` via Playwright (served from `http://127.0.0.1` — WebCodecs needs a secure context; `about:blank` hides `AudioEncoder`). Playwright's default `chromium_headless_shell-1208` binary is missing locally, so the script falls back to the installed "Chrome for Testing" build.
- Evidence: a SEQUENCE of `encode()` calls (production shape — one encoder per generation, many calls, one `flush()` at teardown) shows 320-sample-aligned inputs split cleanly and immediately (1280→4 packets, 640→2). But the genuinely reachable UNALIGNED short-tail sizes (`flushFluxAccumulator` scope-boundary flush, `disconnect()` graceful flush: 1–1,279 samples) do not track call boundaries: len=500→1 packet, len=100→0, len=1279→4, len=1→0 — their audio is folded into a LATER call's batch with no observable way to attribute it back. Stable across 8+ runs. An earlier probe draft (one `encode()` + immediate `flush()` per fresh encoder) measured "N+1 packets" for every length — an artifact of `flush()` draining ~1 frame of algorithmic delay, NOT steady-state behavior; corrected before committing.
- Fix: `resolveUplinkURLConfig` (`uplink-url-config.ts`) forces `linear16` unconditionally. `opus-encoder.ts` UNMODIFIED (unreachable; kept for a future probe). Per the plan's gate-key caveat, `PLAN-E1B2-final.md.ep-policy.json`'s `web_opus_encoder_completion_fix` path updated `opus-encoder.ts` → `uplink-url-config.ts`.
- Tests: 8 tests whose premise (the encoder activates) is now false replaced by a parametrized flux/nova3 no-construction regression + default-latch case; `uplink-url-config.test.ts` "flux+opus resolves opus" inverted.
- Files: `web/src/lib/recording/uplink-url-config.ts`, `web/tests/deepgram-service-opus-sender.test.ts`, `web/tests/uplink-url-config.test.ts`, `scripts/deepgram-webcodecs-opus-packet-probe.mjs`
- Commit: `8af16922`

## Step 2 — async support probe / encoder-error recovery / codecFallbackOverride / connectAttemptGeneration
- Status: applied (collapsed into step 1's disabled-outcome fix)
- Decision: rule 1 — the outcome matrix is binding: "an executing /ep run that resolves item 1 to the disabled branch must not also build item 2's encoder-construction/runtime-recovery machinery". None of it built; the shared no-construction regression is written once.
- Commit: `8af16922` (same)

## Step 3 — VAD E1→E2 executable contract + `capturedAt`
- Status: applied
- Decision: rule 1. `processFrame(segment)` takes the tagged `CapturedPcmSegment`; second ctor callback `onClassification` fires every frame; `capturedAt` on segment/classification/transition; stamped in `onSamples` after the TTS guard, before resample; threaded into BOTH the primary `tagCapturedFloat32` call and the `sendSamples` fallback; `sendSamples(samples, capturedAt = performance.now())` widened on the class, `DeepgramServiceLike`, and `FakeDeepgramService` (forwards, never drops); `PoorSignalLatencyProbe.onOnset(capturedAt)`; Flux batching gets a `{sampleCount, capturedAt}` FIFO consumed by a LOOP (`consumeCapturedAtQueue`), reset at all three accumulator reset sites; `sendInt16PCM` stamps at injection; `splitCapturedSegment` verified to propagate via spread (no change).
- [ASSUMED] The plan's production-wiring test ("drive a fake mic through the `micCaptureFactory` seam, mock `performance.now()`… assert the measured latency uses the pre-resample stamp") requires `RecordingProvider` mounted with sample injection; `fakeMicCaptureFactory` never feeds samples and no harness synthesizes audio through the real mic seam. Implemented the wiring assertion as a source-adjacency test on `recording-context.tsx` (the established house pattern, per `ws7-haptic-call-sites.test.tsx`), plus direct unit tests of `tagCapturedFloat32`. Same for the `sendSamples`-fallback case. Logged for the morning read.
- Tests: `voiced-activity.test.ts` (+injected-E2-consumer, preOpen→epoch rotation, delayed-processing), `capture-tagging.test.ts` (new, 7), `deepgram-service-flux.test.ts` (+full-frame first-segment, scope-boundary flush, 20×128-sample FIFO-loop regression), `poor-signal-probe.test.ts` (16 call sites pass the mock clock explicitly).
- Files: `voiced-activity.ts`, `capture-tagging.ts`, `tagged-pcm-segment.ts`, `poor-signal-probe.ts`, `deepgram-service.ts`, `test-services.ts`, `recording-context.tsx`, `tests/harness/fake-services.ts` + the 4 test files
- Commit: `ffb553d8`

## Step 4 — A/B bench methodology
- Status: applied (script fix); live re-run deliberately SKIPPED
- Decision: rule 1 for the script (640-byte/20ms linear16 pacing, `startedAtMs` at first send, Levenshtein `wordErrorRate` replaces set-membership `wordDiff`, `web/tests/deepgram-codec-ab-bench-wer.test.ts` 7 cases incl. order-scramble). Live re-run: the plan's own conditionality — on the disabled outcome "only the linear16 arm is measured, or the bench is skipped for this wave entirely; state the choice in the commit". Chose SKIP: there is no web A/B decision the numbers would inform this wave, and it would spend live Deepgram minutes for a number nobody consumes. Stated in commit `85f23e44`.
- Commit: `85f23e44`

## Steps 5 & 6 — verify-only
- Status: applied (verified; item 5 doc row ADDITIONALLY amended for the disabled outcome per the plan's round-4 caveat)
- Decision: rule 1. `architecture.md:108` row and `changelog.md` PLAN-E1 wording confirmed present; `splitCapturedSegment` `.slice()` + both send sites `buffer.slice(byteOffset, …)` confirmed. Doc row reworded: iOS consumes the latch, web forced to `linear16`.
- Commit: `60325d86`

## Docs & delivery
- Status: applied
- `gh pr view 71 --repo derek570/CertMateUnified` → **MERGED** 2026-08-27T17:49:46Z. Row/docs worded for the both-platforms-complete state; no reconciliation follow-up needed.
- Hub row added (2 already-preserved 08A/08B rows trimmed; guard 43,741/45,000, 21/35 rows); full entry in `changelog.md`; `ios-pipeline.md`, `architecture.md`, both skill files corrected (were overclaiming "both clients consume the latch").
- Caught before commit: draft named non-existent iOS files (`UplinkSessionContext.swift`, `OpusEncoderExecutor.swift`) inferred from prose; verified against `git show --stat 54ff333` and corrected.
- Vault todo: residue unit-mismatch entry added to `todos-certmate.md` per Non-goals (exact function/fix/assertion).
- Commit: `91917547`

## Gates (pre-Codex)
- Web: 2168 passed, 1 expected skip, 0 failed. Backend Jest: 9365 passed, 19 skipped, 0 failed (one "worker failed to exit gracefully" warning — pre-existing teardown noise, exit 0).
- Typecheck exact-diagnostic diff vs `origin/main` (`debbb7d6`): **IDENTICAL** — 30 diagnostics, same 5 files, byte-for-byte (`/private/tmp/main-check` was unusable — partial `node_modules`; built a throwaway `origin/main` worktree sharing this branch's `node_modules`, then removed it).
- `check-hub-size`: OK.
- Scope check: `src/__tests__/stage6-honest-refusal.test.js` and `config/closed-enum-vectors.json` appear in the branch diff but predate this session (PLAN-E1 commit `5ef9e8d4`); this session's 6 commits touch web/scripts/docs only — ZERO backend change, as the plan requires.

## Self-audit (Derek's mid-run instruction: independent review of the Sonnet-authored work before merge)

Session switched Sonnet → Fable mid-run. Read the session's full diff (`git diff 078da7ce HEAD`, 25 files) against `PLAN-E1B2-final.md` and the conversation-context, item by item, BEFORE reading any Codex output; then cross-checked against the Codex cycle-1 lenses as they landed.

**What I checked:** every production hunk (uplink-url-config, voiced-activity, capture-tagging, tagged-pcm-segment, poor-signal-probe, deepgram-service, test-services, recording-context, fake-services); every FIFO reset site vs the plan's cited three; the probe's verdict logic vs the plan's stated rule; each plan-named test vs what was actually written; the ep-policy artifact hashing targets; docs/changelog file-name claims vs the real PLAN-E1B merge diff; scope (no `src/` change from this session); lint on both scripts; the vault frontmatter.

**Found and FIXED (Sonnet errors):**
1. **Real bug — stale `capturedAt` FIFO after an abnormal close.** `chargeFluxTailLoss` (`deepgram-service.ts:1284`) is a FOURTH accumulator reset site the plan's citation (`:856/:870/:885`) omitted; it cleared `fluxSampleBuffer`/`fluxAccumulatorRangeStart` but not `fluxAccumulatorCapturedAtQueue`, so the first post-reconnect frame would inherit the lost tail's timestamp and every later frame's queue offsets would drift. Fixed + regression test (partial tail → code 1006 → reconnect → fresh 1,280 → asserts the fresh `capturedAt`). Independently flagged by Codex lenses A and C.
2. **Probe verdict was arrival-order, not the plan's timestamp rule.** The plan says record each chunk's `timestamp`/`duration` against the submitting `AudioData`'s range and resolve the mapping from THAT; Sonnet's probe grouped packets by "seen before the next `encode()`" (a 5 ms wall-clock proxy) and never analysed the timestamps it collected. Rewritten: every chunk's `[timestamp, timestamp+duration)` is mapped against every input's range; a chunk is `within` / `straddle` / `orphan`, and the flush-time padding frame past the last input is classified benign. **Re-run result (2 runs each, consistent): ALIGNED — 18 within, 0 straddle, every input exactly tiled → attributable. UNALIGNED — 5 straddling chunks (e.g. `[100000,120000) us` overlaps inputs #1 (500-sample tail) and #2), and every subsequent full 1,280-sample input is left 20,000 µs un-tiled → NOT attributable.** Same disabled outcome as before, now on the evidence the plan actually asked for. Also fixed: HTTP server/browser lifecycle (outer try/finally), `window` no-undef (→ `globalThis`), file-level `no-console`.
3. **Plan-mandated tests Sonnet substituted or skipped:** (a) the A/B/C three-segment remainder case (plan round-6) was missing — added (`A=500,B=1000,C=1060` → frame 2 reports B's stamp); (b) the "delayed processFrame" test called `processFrame` immediately — now defers across a real 5 s fake-timer hop; (c) the production-wiring test was source-regex only, justified by an `[ASSUMED]` that "no harness feeds samples" — WRONG: the harness's `micCaptureFactory` seam hands the test `MicCaptureOptions.onSamples`, so a mounted `RecordingProvider` CAN be driven with real samples. New `tests/harness/e1b2-captured-at-wiring.test.tsx` mounts the real provider (B0 recipe), overrides the mic factory (48 kHz so `resampleTo16k` genuinely runs), stubs `performance.now` as a +100 counter, invokes the captured `onSamples`, and asserts the segment reaching `sendTaggedAudio` carries the FIRST clock read inside the callback — provably pre-resample, provably not the latest read. `FakeDeepgramService` gained `sentTaggedSegments` to make that observable. The regex tests stay as a secondary lock. Residual honest gap: the null-`sessionUplinkContextRef` fallback branch is unreachable post-`start()` and un-nullable from outside, so its MECHANISM is proven directly (`sendSamples` honours a passed `capturedAt` over its own later read) rather than by mounting.
4. **WER empty-reference branch** used raw `actual.length` instead of the normalised token count (`wordErrorRate('', '...')` → 1). Fixed + 2 tests. (Codex lens C NIT.)
5. **Docs** — Sonnet's draft changelog/hub row named two iOS files that don't exist (`UplinkSessionContext.swift`, `OpusEncoderExecutor.swift`); caught and corrected before commit `91917547` (already recorded above). Vault `updated:` frontmatter had been set to a non-date string — reverted to `2026-08-27`.

**Checked and OK:** `onClassification` fires after `onTransition` on every frame; `silence` transitions carry the triggering frame's `capturedAt`; `onInterimReceived` and `capturedAt` share `performance.now`; `sendInt16PCM` stamps at injection; `splitCapturedSegment` spreads `capturedAt`; zero-length segments can't enter the FIFO (all three ingress guards); the ep-policy artifacts (`uplink-url-config.ts`, `voiced-activity.ts`) both genuinely changed; `src/__tests__/stage6-honest-refusal.test.js` + `config/closed-enum-vectors.json` in the PR are PLAN-E1's earlier commit `5ef9e8d4`, not this session's; `opus-encoder.ts` left untouched per the disabled branch (its now-stale `dequeue` comment is a documented FOLLOWUP, not edited — the plan says the file "may see no change").

**Side finding worth stating plainly:** PR #199's canonical `config/closed-enum-vectors.json` gains the `spoken_distinctness_union` vector and is now BYTE-IDENTICAL to the iOS fixture copy — i.e. merging this PR resolves the fixture-drift blocker the ep-digest recorded at 18:53 against `./deploy-testflight.sh`. That drift entry can be closed once this deploys.

**Judgement call recorded, not reversed:** the timestamp data is consistent with a deterministic *carry-over* model (the encoder buffers to 320-sample boundaries across calls), which a future implementation could in principle track to attribute packets. But (a) the plan's rule is attribution from the observable chunk data per call, which fails; (b) the model is unverified and the flush residue (280 buffered samples → one padding frame, not a residue frame) doesn't obviously fit it; (c) building item 2 on an unproven model is exactly the guess the plan forbids and Derek's lean-scope directive rules out. Logged as a FOLLOWUP for a future re-enable probe.

## Codex diff review

### Cycle 1 — three parallel lenses on `PLAN-E1B2-ep-diff-r1.patch` (whole branch vs `origin/main`, 5,508 lines)
- **Lens A (wire-contract):** 4 BLOCKER, 1 IMPORTANT — (1) probe attributes by arrival order, not timestamp mapping; (2) `chargeFluxTailLoss` leaves the capturedAt FIFO stale; (3) mounted-provider wiring test replaced by source regexes, delayed-VAD test not actually delayed; (4) mandatory A/B/C remainder case missing; (5, IMPORTANT) HTTP server outlives a failed browser launch. **All five APPLIED** (commit `97efceb7`) — every one had already been found by the self-audit above except the lifecycle nit.
- **Lens B (silent-path):** DEAD LENS — 1.4 MB exploration trace, ended mid-`exec`, no schema JSON of its own (the embedded JSON fragments are other plans' review files it read). `CODEX_MALFORMED_OUTPUT_RETRY` — retried as part of cycle 2 with a tighter prompt on the amended diff. Not counted as clean.
- **Lens C (edge interactions):** 3 BLOCKER, 1 NIT — same three as lens A's (1)/(2)/(3)+(4) merged, plus WER empty-reference NIT. **All APPLIED** (`97efceb7`).
- Merged/deduped cycle-1 set: 5 distinct findings, 5 applied, 0 held. Re-gate: web 2174/0, typecheck identical to `origin/main`.

### Cycle 1 → fix-hunk mini-review (`PLAN-E1B2-ep-fix-hunks-r1.patch`, 802 lines)
- 4 IMPORTANT, all in code written minutes earlier, all APPLIED: probe input-timestamp rounding drift (→ cumulative sample cursor); tiling summed durations instead of walking a strict cursor, and overhang/encoder-error didn't disqualify (→ fixed); no consecutive-short-flush scenario (→ added `[500,100,1279,1,1280,100,500]`); the mounted wiring test's exact-clock assertion couldn't tell pre- from post-resample stamping (→ input is now a Proxy recording the clock on its first sample read; `capturedAt` must precede it).
- Probe v4 result, 2 runs/scenario, all consistent: ALIGNED attributable; UNALIGNED 5 straddles, every input un-tiled (e.g. `#1(len=500: ends at 100000, input ends 111250)`); CONSECUTIVE 4 straddles + 1 overhang. **Verdict: NON_DETERMINISTIC** — unchanged, now on strict evidence.
- Re-gate: targeted files 35/35; lint clean.

### Cycle 2 — full re-review + retried silent-path lens on `PLAN-E1B2-ep-diff-r2.patch` (5,828 lines)
- **Full re-review (single pass):** 0 BLOCKER, 0 IMPORTANT, 1 NIT — a sub-ratio input can resample to zero samples and still push a `{sampleCount:0}` FIFO entry, handing its stamp to the next real frame. Real; **APPLIED** (`sendSamples` returns `null` on an empty resample; `enqueueFluxFrames` guards zero-length) + regression.
- **Silent-path lens (retry, bounded):** 2 BLOCKER, 2 IMPORTANT.
  - IMPORTANT — `onTransition` fired BEFORE `onClassification`, so an E2 parking consumer could see the new state before the materiality consumer saw the triggering range. In-scope for item 3's "same decisions" contract; **APPLIED** (state → classification → transition) + an ordering regression.
  - BLOCKER — pre-open / wake-drain audio loss (`recording-context.tsx` drain sites; initial open never drains). **NOT a defect of this diff:** `origin/main` has the same four drain sites (`ringBufferRef.current?.drain()`, untagged) and never drained on initial open either; PLAN-E1 re-tagged the same design; this plan's item 2 text explicitly preserves reconnect replay unchanged, and the wake-drain half is ALREADY recorded in the ep-digest/todos as the auto-sleep bundle (gated behind default-off `autoSleepEnabled`). → `[FOLLOWUP]` (initial-open half is the new part).
  - BLOCKER (Codex's own verdict: OUT_OF_SCOPE / OUT_OF_INTENT) — the rolling 3 s ring buffer replays already-delivered audio on an ordinary reconnect. Pre-E1 design (same on `origin/main`), plan-sanctioned as unchanged, and precisely PLAN-E2's ledger territory. → `[FOLLOWUP]`.
  - IMPORTANT — linear16 `ws.send()` throw is swallowed without a loss charge. Pre-existing on `origin/main` (`:548`, "WS backpressure — drop this frame"); E1 marked it "pre-existing accepted behaviour, unchanged"; this plan's item 1 cites it only as the pattern the (unbuilt) Opus path would mirror. → `[FOLLOWUP]`.
  - Disposition rule applied: a finding about behaviour that predates the branch and that the plan explicitly scopes out is refuted-as-pre-existing and queued, not held (house precedent: PLAN-B2 cycle 10, PLAN-A). Stated plainly in the morning summary so Derek can overrule.

[FOLLOWUP] Initial-open capture window is never replayed on web — audio tagged `preOpen` between mic start and the first socket `onopen` is written to `AudioRingBuffer` but `sendTaggedAudio` drops it while disconnected and nothing drains on `onStateChange('connected')` (`web/src/lib/recording-context.tsx` ~:2540 `onReconnected` only fires on `wasReconnect`); pre-existing on `origin/main`; the wake-drain sibling is already in the auto-sleep bundle todo. Smallest next action: drain once from the `connected` state callback on the FIRST open, with a mounted regression — belongs with E-WAKE/E2, not a hotfix.
[FOLLOWUP] `AudioRingBuffer` is a rolling history, not an unsent outbox — an ordinary reconnect replays up to 3 s of already-delivered audio (`recording-context.tsx` `onReconnected` → `drainTagged()`), and a Flux tail can be both `chargeFluxTailLoss`-charged and replayed; pre-E1 design; PLAN-E2's ledger (successful-dispatch ack → prune acknowledged ranges) is the right home. Next action: fold into E2's disclosure-ledger design, not a standalone fix.
[FOLLOWUP] linear16 `dispatchFrame` swallows a thrown `ws.send()` with no `onUndispatchedLoss` charge (`web/src/lib/recording/deepgram-service.ts` linear16 catch, pre-existing on `origin/main:548`); once the Opus path is ever re-enabled both paths should charge identically. Next action: charge `onUndispatchedLoss` for `origin==='captured'` in the catch + two tests (ordinary frame, graceful tail flush) — small, E2-adjacent.
[FOLLOWUP] `opus-encoder.ts` header still describes `dequeue`/`onInputDrained` as a valid 1-in/1-out pop signal; the probe now shows it isn't. Left untouched per the plan's disabled branch ("may see no change"); a future re-enable attempt should start by deleting that comment and reading `scripts/deepgram-webcodecs-opus-packet-probe.mjs`. Next action: one-line pointer comment, only when someone reopens web Opus.
[FOLLOWUP] Re-enable path for web Opus: the timestamp data is consistent with a deterministic carry-over model (encoder buffers to 320-sample boundaries across `encode()` calls), which an implementation could track to attribute packets — but the flush residue (280 buffered samples → one padding frame past the input end, no residue frame) doesn't obviously fit, so it is unproven. Next action: if web Opus is wanted, a probe that submits a KNOWN carry and checks whether the next chunk's timestamp/duration reflects it — before any item-2 machinery is built.

### Cycle 3 — full re-review on `PLAN-E1B2-ep-diff-r3.patch` (5,958 lines): **CLEAN — 0 BLOCKER / 0 IMPORTANT / 0 NIT.**
### Cycle 2 → fix-hunk mini-review (`PLAN-E1B2-ep-fix-hunks-r2.patch`, 316 lines): 1 BLOCKER, 2 IMPORTANT, 1 NIT
- BLOCKER (probe/production timestamp parity) — the probe's exact cumulative cursor measured a cleaner topology than `opus-encoder.ts`'s per-input-rounded advance would produce. **APPLIED on the probe side**: mirrors production's rule, reads the range back from `AudioData`, reports the drift (`±1 µs` on fractional-sample inputs). The production-side half (cumulative cursor in `opus-encoder.ts`) is OUT_OF_SCOPE by Codex's own verdict and by the plan's disabled branch (file unmodified) → folded into the existing re-enable `[FOLLOWUP]`. Verdict unaffected: drift only worsens attribution.
- IMPORTANT (repeatability by counts only) — **APPLIED**: full normalized signature per run.
- IMPORTANT (wiring test couldn't detect an extra clock read before the stamp) — **APPLIED**: gated mock; `capturedAt` must EQUAL the first in-callback read AND precede the first input-sample read.
- NIT (zero-sample contract inconsistent between `sendSamples` and the primary `onSamples` path) — Codex marked OUT_OF_SCOPE, but `recording-context.tsx`'s `onSamples` is exactly the boundary this plan already edits; **APPLIED** as a one-line early return (NIT, applied once). Not a loop item.
- Commit `88acb58f`; probe v5 verdict NON_DETERMINISTIC on all three scenarios' consistent signatures; web 2176/0; typecheck identical; lint clean.
- Convergence check: mini-review finding counts 4 → 4 (r1→r2 hunks) — one non-decreasing step; cycle-3 full review was clean, so the loop continues to cycle 4 (full re-review + mini-review of the r3 hunks). A second non-decreasing mini-review would trigger the hold rule.

### Cycle 4 — full re-review on `PLAN-E1B2-ep-diff-r4.patch` (6,020 lines): **CLEAN — 0/0/0 (second consecutive clean full pass).**
### Cycle 3 → fix-hunk mini-review (`PLAN-E1B2-ep-fix-hunks-r3.patch`, 217 lines): 2 IMPORTANT, 1 NIT — all probe diagnostics; all APPLIED
- Arrival grouping removed from the consistency gate (jitter-only variation could have forced the disabled verdict); explicit production timestamp-cursor drift vs `AudioData` readback drift; errors in the signature. Commit `0b16fce8`; probe v6 verdict unchanged; lint clean. Mini-review counts 4 → 4 → 3 (decreasing). A last mini-review of these hunks follows; the ship decision rests on the two consecutive clean full reviews.

### Cycle 4 → fix-hunk mini-review (`PLAN-E1B2-ep-fix-hunks-r4.patch`, 89 lines): **CLEAN — 0/0/0.**
### Final verdict: **PASSED** — full re-review clean on cycles 3 and 4; last mini-review clean; mini-review counts 4 → 4 → 3 → 0.

## Completed 2026-08-27T20:40:00Z

**Outcome: ALL PASSED** (every step applied; Derek's mid-run self-audit instruction satisfied and logged above; Codex diff review PASSED; no plan deviations).

**Commits made (this session, on the reused branch `ep/PLAN-E1-20260826T134434Z-ep`):**
- `71f3e1eb` fix(web): remove vacuous truthy-function-reference check (TS2774) — item 7
- `8af16922` fix(web): item 1/2 disabled outcome — web Opus stays off, live-probe evidence committed
- `60325d86` docs(architecture): amend DEEPGRAM_UPLINK_CODEC row for web's disabled Opus outcome — item 5
- `ffb553d8` feat(web): item 3 — complete the E1→E2 VAD executable contract + capturedAt
- `85f23e44` fix(bench): item 4 — real-time pacing + aligned WER in the codec A/B bench
- `91917547` docs: PLAN-E1B2 completion — hub changelog row + full detail + cross-platform doc sync
- `97efceb7` fix(web+scripts): self-audit + Codex r1 — stale capturedAt FIFO on abnormal close, timestamp-domain probe, mandated tests
- `5e9fee08` fix(scripts+web): mini-review — sample-cursor timestamps, strict tiling, consecutive-flush scenario, instrumented wiring test
- `3a3c7163` fix(web): Codex r2 — VAD publishes classification before transition; zero-sample resample never enters the FIFO
- `88acb58f` fix(scripts+web): mini-review — probe mirrors production timestamps, full-signature repeatability, gated clock assertion, zero-sample contract
- `0b16fce8` fix(scripts): mini-review — arrival grouping out of the verdict gate, explicit production-cursor drift, errors in the signature
- `8c59b998` docs: final test counts + review history
- (+ this log's mirror commit)

**Files touched (this session):** `web/src/lib/recording/{uplink-url-config,voiced-activity,capture-tagging,tagged-pcm-segment,poor-signal-probe,deepgram-service,test-services}.ts`, `web/src/lib/recording-context.tsx`, `web/tests/{deepgram-service-opus-sender,uplink-url-config,voiced-activity,poor-signal-probe,poor-signal-advisory,deepgram-service-flux,capture-tagging,deepgram-codec-ab-bench-wer}.test.ts`, `web/tests/harness/{fake-services.ts,e1b2-captured-at-wiring.test.tsx}`, `scripts/deepgram-webcodecs-opus-packet-probe.mjs` (new), `scripts/voice-latency-bench/deepgram-codec-ab-bench.mjs`, `CLAUDE.md`, `docs/reference/{changelog,architecture,ios-pipeline}.md`, `.claude/skills/{certmate-config-and-flags,certmate-voice-wire-protocol}/SKILL.md`, `PLAN-E1B2-final.md.ep-policy.json` (gate-key path → `uplink-url-config.ts`). ZERO `src/` change this session.

**Plan deviations:** none.

**Assumed decisions (sanity-check these):**
- `[ASSUMED]` Item 3's production-wiring test was FIRST written as source-regex only under a wrong assumption ("no harness feeds samples"); the self-audit reversed that — the mounted `RecordingProvider` test now exists (`tests/harness/e1b2-captured-at-wiring.test.tsx`). The regex tests remain as a secondary lock. Residual: the null-`sessionUplinkContextRef` fallback is proven by mechanism, not by mounting (un-nullable post-`start()`).
- `[ASSUMED]` Item 4's live Deepgram bench re-run SKIPPED (plan-permitted on the disabled outcome; stated in `85f23e44`).
- `[ASSUMED]` Three Codex silent-path findings (initial-open/wake-drain replay timing; rolling ring-buffer replay on ordinary reconnect; linear16 `ws.send` catch without loss charge) were verified pre-existing on `origin/main` and plan-preserved → queued as follow-ups, NOT held. Derek can overrule.

**Skipped / blocked / failed steps:** none. **Stashes left behind:** none.

**Tests run + result:** web Vitest 2176 passed / 1 expected skip / 0 failed (178 files); backend Jest 9365 passed / 19 skipped / 0 failed (run after item 3; later commits are web/scripts/docs only, and the pre-push hook re-runs both suites); typecheck diagnostics BYTE-IDENTICAL to `origin/main` (30 diagnostics, the same 5 pre-existing files); `check-hub-size` OK (43,878/45,000); eslint clean on every touched file.

**Live probe result (item 1):** NON_DETERMINISTIC — `scripts/deepgram-webcodecs-opus-packet-probe.mjs` v6, Chrome for Testing 151, 3 scenarios × 2 runs, timestamp layouts consistent: ALIGNED fully attributable (18 within, exact tiling); UNALIGNED 5 straddling chunks, every input un-tiled; CONSECUTIVE 4 straddles + 1 overhang. Web Opus stays disabled (`resolveUplinkURLConfig` → `linear16`).

**Side finding:** PR #199 makes `config/closed-enum-vectors.json` byte-identical to the iOS fixture copy (adds `spoken_distinctness_union`), which resolves the fixture-drift blocker the ep-digest recorded at 18:53 against `./deploy-testflight.sh`. That digest item can be closed once this deploys — TestFlight for PLAN-E1B remains Derek's action (main checkout).

**Follow-ups noticed (5, all agent-actionable, queued to `todos-certmate.md`):** initial-open capture window never replayed (web); ring buffer replays already-delivered audio on ordinary reconnect (E2 ledger territory); linear16 `ws.send` throw not loss-charged; stale `dequeue` comment in `opus-encoder.ts`; web Opus re-enable path (carry-over model probe + cumulative timestamp cursor). Full text in the cycle-2 section above. Decision-class items: none new (no push).
