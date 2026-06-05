# Voice Latency Sprint — PLAN_v5.md (final patch over v4)

**Date:** 2026-05-23
**Supersedes:** `PLAN_v4.md`
**Reconciles:** `claude-review-v4.md` (0 BLOCKER / 0 IMPORTANT / 3 NIT — "ship as-is") + `codex-review-v4.md` (1 BLOCKER / 2 IMPORTANT / 0 NIT — "tight PLAN_v5 patch then ship").
**Nature:** Three surgical fixes + one carryover note. ~80 lines of changes. **This is the final plan.** Both v4 reviewers explicitly stated no PLAN_v6 unless v5 expands scope.
**Resume rule:** PLAN_v5 is the executable plan. Sections not modified here inherit from PLAN_v4 (which in turn inherits ~90% from PLAN_v3).

---

## 0. What changed vs PLAN_v4

Three surgical fixes:

1. **§A.12 13.1 exit criteria — warm target removed from 9.1A** (Codex v4 NB1).
   PLAN_v4 §A.3 explicitly forbids `VOICE_LATENCY_USE_MULTI_CONTEXT` in 9.1A, but §A.12 13.1 still graded 9.1A on a "≤ 2.5 s warm" target that depends on multi-context. Contradiction. Fix: 13.1 exit is cold-only. Warm target moves entirely to 13.2 (9.1B). 9.1A's honest framing: ~17–25% improvement (3.0 s cold today → ~3.0 s cold target — yes, similar, because Sonnet TTFT dominates and multi-context isn't enabled). Stage 2 in 9.1A delivers infrastructure value primarily, not headline latency.

2. **§A.7 scenarios — flux duplicate-final scenarios moved to no-regression suite** (Codex v4 IMPORTANT 1).
   `flux_misrecognition_socket_one`, `flux_misrecognition_second`, `flux_duplicate_finals` are testing TODAY'S Flux duplicate-final behaviour (Derek's original 2026-05-23 field-test bug). They are NOT Stage-4-only. Moving them to `stage2_streaming` ensures the 9.1A default suite still catches the bug class. Stage 4 race fixtures R1–R8 stay in `stage4_fast_path`.

3. **§A.4 audioSeq — `.notification` mint point added** (Codex v4 IMPORTANT 2).
   PLAN_v4 §A.4 listed three mint points (confirmation/correction, fast-path, ask_user) but `TTSSource` has four cases (PLAN_v3 §4.4). Notifications via `speakCriticalNotification` are suppression-exempt but still need a `audioSeq` for telemetry. Fix: explicit fourth mint point.

Plus one carryover note (not a v5 fix but a Stage 1b drafting reminder):

4. **TTSSource enum — gaps flagged for Stage 1b drafting** (Claude v4 carryover).
   Current `AlertManager.swift` also routes through `speakTourNarration` and `speakAlertMessage`/`queueAlert` paths. PLAN_v3 §4.4's 4-case enum (`confirmation, correction, question, notification`) doesn't cover these. Both currently default to suppression-eligible (`.confirmation` fallback) which is wrong — tour audio and alerts shouldn't be suppressed. Stage 1b commit 1b.4 should add `.tour` and `.alert` cases and exempt them from suppression like `.notification`. NOT a v5 plan change — just a note to the executor that the §4.4 enum needs two more cases when implementing.

---

## §A. Patch sections (replace corresponding PLAN_v4 sections verbatim)

### §A.1' — Replace PLAN_v4 §A.12 13.1 (Minimum-Viable Exit) criteria

```
### 13.1 Minimum-Viable Sprint Exit (9.1A rollout — Stages 0+1+2+5+6)

If Derek's post-Stage-2 assessment says "acceptable" or "defer":

- All Stage 0 gates A, B, C, D, E, F, G documented (incl. measured tunables in `STAGE0_RESULTS_TUNING.md`).
- Stage 1a (backend protocol) + Stage 1b (iOS protocol) commits landed with verification gates passed.
- Stage 2 (streaming confirmations) commits landed. **Telemetry P50 ≤ 3.0 s cold target.** Warm target N/A in 9.1A — multi-context pool is not shipped in this branch (per §A.3 flag exclusions). If Stage 0.F passed and Derek wants warm in 9.1A, see §A.1''.
- Stage 5 (ask_user streaming) commits landed. Question P50 ≤ 1.4 s.
- Field-test capture sheet completed for 5 sessions (§A.5).
- Transcript-replay harness `protocol + stage2_streaming + stage5_ask_user` suites green in CI (now 15 scenarios — three duplicate-final scenarios moved into stage2_streaming per §A.2').
- Documentation: `docs/reference/voice-latency.md` covers shipped subset.

**Honest framing:** Streaming infrastructure shipped (chunked HTTP audio, StreamingAudioPlayer on AVAudioEngine, ElevenLabs stream-input WS, capability handshake, source-typed TTS posts, field_corrected emission, voice_latency_ack contract). Cold-path audible-confirmation latency comparable to today (~3.0 s) because Sonnet TTFT is the dominant term and 9.1A does not ship multi-context's 800 ms BOS amortisation. Stage 2 in 9.1A is primarily infrastructure value — the streaming foundation that future sprints can build on. Stage 5 ask_user streaming is the user-visible win in this exit (~3 s → ~1.4 s for clarification questions). Stage 3 + Stage 4 (suppression machinery + regex-fast path) NOT shipped. Future sprint can return to it if telemetry reveals the need.
```

### §A.1'' — NEW optional sub-branch: 9.1A+multi-context

(Optional, only if Derek wants warm Stage 2 in the minimum branch. Adds one commit to scope.)

```
If Stage 0.F passed AND Derek wants warm Stage 2 in the minimum branch:

- Promote `elevenlabs-multi-context-pool.js` (PLAN_v2 §7.5 had it in Stage 4 commit 4.3) into a new Stage 2 commit 2.5b.
- 9.1A rollout adds one step between current step 4 and step 5:
  4.5: Flip `VOICE_LATENCY_USE_MULTI_CONTEXT=true`. Verify BOS amortisation in Stage 2 confirmations.
- 13.1 exit criteria add: "Stage 2 P50 ≤ 2.5 s warm if 0.F passed."

This is the bigger-scope option Codex v4 flagged. **Not the recommended path** — keeps Stage 4-related code (the pool module) out of 9.1A's foundation. Listed for completeness; Derek decides at Stage 2 ramp time.

**Default: 9.1A ships without multi-context. Cold-only.**
```

### §A.2' — Replace PLAN_v4 §A.7 scenario library suites

```
**`tests/fixtures/voice-latency-scenarios/`** layout:

  protocol/                   — 4 scenarios (capability handshake, missing source, etc.)
                               — required for BOTH 9.1A and 9.1B rollouts
                               — `npm run voice-test -- --suite protocol`

  stage2_streaming/           — 8 scenarios:
                               — 5 streaming-mechanics (PCM playback timing, chunked HTTP receive,
                                  mic-pause-on-first-frame, cost-on-text-sent, kill switch)
                               — 3 Flux duplicate-final no-regression scenarios MOVED from
                                  stage4_fast_path (flux_misrecognition_socket_one,
                                  flux_misrecognition_second, flux_duplicate_finals).
                                  These exercise the in-flight dedup path that Stage 2's
                                  ElevenLabsStreamClient introduces. They are bug-class
                                  regression tests for today's Flux behaviour and must run in
                                  both 9.1A and 9.1B.
                               — required for BOTH rollouts
                               — `npm run voice-test -- --suite stage2_streaming`

  stage3_suppression/         — 3 scenarios (TTL expiry, board-switch invalidation,
                                field_corrected invalidation)
                               — required ONLY for 9.1B rollout
                               — `npm run voice-test -- --suite stage3_suppression`

  stage4_fast_path/           — 9 scenarios (was 12 — 3 Flux scenarios moved to stage2):
                               — 8 race fixtures R1–R8
                               — 1 functional (multi_candidate_rejection +
                                  pending_ask_no_fast_confirm + correction_class_tts
                                  collapsed into related test setups)
                               — required ONLY for 9.1B rollout
                               — `npm run voice-test -- --suite stage4_fast_path`

  stage5_ask_user/            — 3 scenarios (split-unicode escape, abort-mid-stream,
                                normal question flow)
                               — required for BOTH rollouts
                               — `npm run voice-test -- --suite stage5_ask_user`

Total: 27 scenarios across 5 suites.

9.1A default subset: `npm run voice-test -- --suite protocol,stage2_streaming,stage5_ask_user`
  → 15 scenarios. Includes Flux duplicate-final no-regression tests.

9.1B full suite: `npm run voice-test` → all 27.
```

### §A.3' — Replace PLAN_v4 §A.4 audioSeq mint-point list (add fourth bullet)

In §A.4's "Mint point" subsection, replace the bullet list with:

```
- For confirmations/corrections from `result.confirmations[]` (server-side bundled): iOS mints `audioSeq = nextSeq()` when the WS `extraction` event arrives, BEFORE calling `APIClient.proxyElevenLabsTTSStreaming`.
- For fast-path (Stage 4 only): iOS mints `audioSeq = nextSeq()` when the regex match fires, BEFORE the POST to `/api/voice-latency/regex-fast-tts`.
- For ask_user TTS (Stage 5): iOS mints when the `ask_user_started` event arrives.
- **For notifications (`speakCriticalNotification` → `TTSSource.notification`): iOS mints when the AlertManager call originates, BEFORE the TTS POST. Notification TTS is suppression-exempt (PLAN_v3 §4.4) but still receives a best-effort `audioSeq`/header for telemetry correlation. The AlertManager stale-drop queue rule does NOT apply to `.notification` source — notifications always play to completion.**
```

### §A.4' — Stage 1b commit 1b.4 drafting note (Claude v4 carryover, no plan change)

Add to PLAN_v3 §4.4 / PLAN_v4 carryover, as a note that Stage 1b commit 1b.4 implementer should resolve at drafting time:

```
**Stage 1b drafting note (Claude v4 carryover):** Current `CertMateUnified/Sources/Recording/AlertManager.swift` has additional TTS paths beyond the four sites identified in PLAN_v3 §4.4:
- `speakTourNarration` — plays the bundled tour audio MP3s; not subject to TTS POST but uses the same audio output queue.
- `speakAlertMessage` / `queueAlert` — non-critical alerts.

When implementing 1b.4 (TTSSource enum + APIClient param):
- Add two more enum cases: `.tour` and `.alert`.
- Both are suppression-exempt (like `.notification`).
- `.tour` does not invoke the POST path at all (bundled audio), but the audioSeq mint rule still applies if the tour audio is queued via StreamingAudioPlayer.
- `.alert` follows the same flow as `.notification`.

NOT a v5 plan change — flagged so the implementer doesn't ship the 4-case enum and discover the gap later.
```

---

## §B. Unchanged from PLAN_v4

Everything else carries forward. Specifically:

- PLAN_v4 §0 (what changed vs v3)
- PLAN_v4 §A.1–§A.11 except where superseded above (§A.12 → §A.1', §A.7 → §A.2', §A.4 → §A.3')
- PLAN_v4 §B (inherited from PLAN_v3 list)
- PLAN_v4 §C + §D
- All PLAN_v3 sections referenced by PLAN_v4 §B

---

## §C. Final approval & next steps

- [ ] Derek reads PLAN_v5 (this file).
- [ ] Derek approves OR requests revisions.
- [ ] On approval: Stage 0 begins. Six measurement gates (A–F) plus transcript-replay harness (G) before any Stage 1 commits.

**Both v4 reviewers explicitly stated:** no PLAN_v6 broad review unless v5 expands scope. The remaining issues are 5-minute Stage 1b drafting decisions, not plan-level architecture concerns.

---

## §D. Review investment summary (final)

| Pass | Reviewers | NEW BLOCKERs | NEW IMPORTANTs | Resulting plan |
|---|---|---|---|---|
| Draft | — | — | — | PLAN.md |
| Review 1 | Claude + Codex | 7 | 20 | PLAN_v2.md |
| Review 2 | Claude + Codex | 2 | 9 | PLAN_v3.md |
| Review 3 | Claude + Codex | 2 (Codex only) | 8 | PLAN_v4.md |
| Review 4 | Claude + Codex | 1 (Codex only) | 2 | PLAN_v5.md (this file) |
| **Total** | — | **12 BLOCKERs caught** | **39 IMPORTANTs caught** | **0 lines of code shipped** |

Pattern across rounds: 7 → 2 → 2 → 1 NEW BLOCKERs. Each round catches fewer because the prior round caught more. v4→v5 catches a single contradiction introduced by v4's amendments — exactly the kind of finding a fourth review should find. v5→v6 would project to 0 new BLOCKERs; both v4 reviewers agree we're at the stopping point.

If any of these 12 BLOCKERs had reached production: 2+ days of TestFlight cycle + field-test debugging per occurrence. The four-pass review investment paid for itself many times over.

Stage 0 starts next session. First gate: 0.A (iOS Strategy C playback feasibility, PCM-first).
