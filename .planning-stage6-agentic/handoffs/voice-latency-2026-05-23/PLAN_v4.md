# Voice Latency Sprint — PLAN_v4.md (tight patch over v3)

**Date:** 2026-05-23
**Supersedes:** `PLAN_v3.md`
**Reconciles:** `claude-review-v3.md` (0 BLOCKER / 2 IMPORTANT / 2 NIT — "approve, stop reviewing, start building") + `codex-review-v3.md` (2 BLOCKER / 6 IMPORTANT / 3 NIT — "revise to tight PLAN_v4, then start").
**Nature:** Small surgical patch. Carry forward 90%+ of PLAN_v3 unchanged. The four substantive changes are listed in §0 and explicit replacement text follows in §A.
**Resume rule:** PLAN_v4 is the executable plan. Sections not modified here inherit from PLAN_v3.

---

## 0. What changed vs PLAN_v3 (the four surgical fixes)

The v3 reviews agreed on the diagnosis. Codex categorised as BLOCKER, Claude as IMPORTANT. Both said the substance is real. PLAN_v4 makes four targeted fixes:

1. **Decision gate moves earlier — from end-of-Stage-3 to end-of-Stage-2** (Codex v3 NB1).
   PLAN_v3 had Stage 3 (suppression machinery) shipping BEFORE Derek's "is it good enough?" assessment. But Stage 3 exists to support Stage 4's fast-path duplication. If Stage 4 is skipped, Stage 3 is dead weight ("proven against zero sources of duplication"). New flow: Stage 0+1+2 land → Derek assesses Stage 2 telemetry → if acceptable, close at Stages 2+5+6 → if too slow, bundle Stage 3+4 as a single fast-path slice.

2. **Stage 3 becomes conditional and bundled with Stage 4** (Codex v3 NB1).
   No more "ship Stage 3 then maybe skip Stage 4." Stage 3+4 are now one decision: ship together as the fast-path slice or skip both. Saves the suppression-machinery engineering cost when Stage 2 alone is acceptable.

3. **§9 rollout split into 9.1A (minimum) and 9.1B (full)** (Codex v3 NB2).
   PLAN_v3 §9.1 still said "Land Stages 1–4 on main" — an implementation agent following that would build Stage 4 despite the conditional gate. Two explicit branches now.

4. **`audioSeq` ownership pinned + cost-tracker split into started/terminal** (Codex v3 NI1 + NI3).
   `audioSeq` is iOS-owned, session-lifetime (not WS-connection-lifetime), attached to HTTP payloads + headers + `voice_latency_ack`. Cost-tracker splits into `recordElevenLabsStreamingStarted` (billable, once) + `recordElevenLabsStreamingTerminal` (counter only, no double-charge).

Plus six smaller cleanups (NI2 wording, NI4 scenario split, NI5 capture template, NI6 Stage 5 dependency note, NN1-NN3).

What did NOT change:

- Locked decisions 1.1–1.20 (PCM default, voice settings, BT detection-only, 0.85 confidence floor, etc.)
- Stage 0 measurement gates A–G (all six gates + harness)
- iOS Strategy C playback architecture
- `field_corrected` wire shape (snake_case `previous_value` + `reason`)
- iOS Alamofire `.responseData` → chunked HTTP fix (Stage 1b commit 1b.6)
- Stage 5 ask_user streaming (independent of Stage 4; clarified in §A.6)
- All research artefacts + 22-row Codex angles table (§16) — table updated to mark Stage-4-only rows

What changed (locked decision 1.21):

| Old (PLAN_v3) | New (PLAN_v4) |
|---|---|
| Stage 4 conditional on assessment after Stage 3 | **Stage 3 + Stage 4 jointly conditional on assessment after Stage 2** |

---

## §A. Patch sections (replace corresponding PLAN_v3 sections verbatim)

### §A.1 — Replace PLAN_v3 §1 row 1.21

```
| 1.21 | **Stage 3 AND Stage 4 are JOINTLY CONDITIONAL — assess after Stage 2 ships.** Run Stages 0 + 1 + 2 first. Field-test the Stage 2 audible latency in real cert sessions. If acceptable (Derek's subjective judgement based on inspector use AND telemetry P50/P95), close sprint at Stages 5 + 6 (skip Stage 3 + Stage 4 entirely). If still too slow, execute Stage 3 + Stage 4 as a single bundled "fast-path slice." **Decision gate: end of Stage 2, before Stage 3 commits begin.** Rationale: Stage 3's suppression machinery exists to support Stage 4's fast-path duplication; building it before deciding whether Stage 4 ships pays for infrastructure that may sit idle. | Codex v3 NB1, Derek 2026-05-23 |
```

### §A.2 — Replace PLAN_v3 §7 intro paragraph

```
## 7. Stage 3 + Stage 4 — Fast-path slice (JOINTLY CONDITIONAL on end-of-Stage-2 assessment)

**Per locked decision 1.21**, neither Stage 3 nor Stage 4 begins implementation until Derek's post-Stage-2 assessment concludes the audible latency is insufficient. Decision gate process:

1. Stage 2 ships with `VOICE_LATENCY_STREAM_CONFIRMATIONS=true`.
2. Derek runs ~5 normal cert sessions in real field conditions using the post-Stage-2 build.
3. **Structured capture** (per §A.5): one-page field-test sheet per session. Captures P50/P95 latency, "felt late" count, "I wondered if it heard me" count, overlap/clip count, free-text verdict (OK / borderline / too slow).
4. Three outcomes:
   - **"Acceptable, close sprint"** → Stages 5 + 6 ship. Stage 3 + Stage 4 skipped entirely. Saves the riskiest commit set in the sprint.
   - **"Borderline, defer fast-path"** → Stages 5 + 6 ship. Stage 3 + Stage 4 deferred to a future sprint, possibly re-prioritised.
   - **"Still too slow, proceed"** → execute Stage 3 + Stage 4 as a single bundled slice. Continues to §7.1 onwards.

**Why this gate exists:** Stage 3 (suppression reservation state machine) exists to support Stage 4 (regex-fast path). If Stage 4 isn't shipping, Stage 3's only value is suppressing legitimate same-value-twice Sonnet repeats within a 12 s window — a rare event with minimal practical impact. Building Stage 3 before the Stage 4 decision pays for ~70% machinery whose runtime success criterion is "did not suppress anything." That's not how to spend engineering time.

**Why bundle Stage 3 + Stage 4:** Stage 3 is wiring for Stage 4. Shipping them together preserves the rollout invariant from §9.1B that "with `SUPPRESSION=false`, the suppression store is never read AND never written." Stage 3 ships in the same TestFlight cycle as Stage 4 iOS work — no half-shipped state.

The rest of §7 (carried from PLAN_v3 §7.1 onwards — eligibility whitelist, race catalogue R1–R8, multi-context gating, audioSeq integration) applies ONLY in the "Still too slow, proceed" branch. In the other two branches, §7 is N/A.
```

### §A.3 — Replace PLAN_v3 §9 with explicit branches

```
## 9. Stage 6 — Rollout (two branches per locked decision 1.21)

### 9.1A — Minimum-Viable Rollout (Stages 0+1+2+5+6, fast-path skipped)

After Stage 2 field assessment concludes "acceptable" or "defer":

1. **Land Stages 0, 1, 2 commits on `main`** with all flags `false`. CI green. iOS TestFlight Build N ships (capability bits + chunked HTTP client + PCM playback).
2. **24h soak.** Confirm zero impact (telemetry shows new paths not exercised at flag=false).
3. **Flip `VOICE_LATENCY_STREAM_CONFIRMATIONS=true`.** Stage 2 live. Telemetry shows latency improvement.
4. **24h soak.** Compare P50/P95 audible-confirmation latency vs baseline.
5. **Derek runs ~5 cert sessions with structured capture (§A.5).** Decision: acceptable / defer / proceed.
6. **If acceptable or defer**: land Stage 5 (`VOICE_LATENCY_STREAM_ASK_USER=true`) on its own ramp.
7. **Close sprint.** Stage 3 + Stage 4 skipped. No `VOICE_LATENCY_REGEX_FAST_TTS`, no `regexFastEnabled`, no multi-context pool flip. Documentation updated to reflect 13.1 exit.

Flags ENABLED in 9.1A: `VOICE_LATENCY_STREAM_CONFIRMATIONS`, `VOICE_LATENCY_STREAM_ASK_USER`. ENV-var-default + kill-switch as live override remain.
Flags NEVER ENABLED in 9.1A: `VOICE_LATENCY_SUPPRESSION`, `VOICE_LATENCY_REGEX_FAST_TTS`, `VOICE_LATENCY_USE_MULTI_CONTEXT`.

### 9.1B — Full Rollout (Stages 0+1+2+3+4+5+6, fast-path included)

Triggered only if Stage 2 field assessment concludes "still too slow, proceed":

1. Steps 1–5 identical to 9.1A.
2. **Land Stage 3 + Stage 4 commits on `main`** with flags `false`. CI green. iOS TestFlight Build N+1 ships with `regexFastEnabled` compile-time flag retained at `false`.
3. **Flip `VOICE_LATENCY_SUPPRESSION=true`.** Verify suppression rate stays at 0% (no fast-path source yet). Confirms wiring.
4. **24h soak.**
5. **(Conditional)** if Stage 0.F passed: flip `VOICE_LATENCY_USE_MULTI_CONTEXT=true`. Verify BOS amortisation.
6. **iOS Build N+2** ships with `regexFastEnabled=true`. Concurrently flip `VOICE_LATENCY_REGEX_FAST_TTS=true`.
7. **Stage 4 field test (10 reads per fast-eligible field per audio route × 4 routes).**
8. **Flip `VOICE_LATENCY_STREAM_ASK_USER=true`** (Stage 5).
9. **Close sprint.** Documentation reflects 13.2 exit.

### 9.2 Kill switch verification (unchanged from PLAN_v3 §9.2; applies to both 9.1A and 9.1B)

### 9.3 Cost monitoring (unchanged from PLAN_v3 §9.3)

### 9.4 Rollback strategy (unchanged from PLAN_v3 §9.4)

### 9.5 Commits — applied per branch

Stage 6 commits 6.1–6.6 from PLAN_v3 §9.5 apply per branch:
- 9.1A executes: 6.2 (STREAM_CONFIRMATIONS) + 6.5 (cost cron) + 6.6 (STREAM_ASK_USER, if Stage 5 shipped). Skips 6.1, 6.3, 6.4.
- 9.1B executes: all six per PLAN_v3 §9.5.
```

### §A.4 — Replace PLAN_v3 §5.1 audioSeq section with full ownership contract

PLAN_v3 §5.1 final paragraph says:

> Per-session monotonic `audioSeq: UInt64` counter (added per Codex v2 PARTIAL B2). AlertManager queue checks `if incoming.audioSeq < queue.lastPlayedSeq { drop_stale }`.

Replace with:

```
**`audioSeq` ownership contract (full specification, addressing Codex v3 NI1):**

- **Ownership:** iOS-owned. Per-`sessionId` monotonic counter held on `AlertManager` (NOT on `ServerWebSocketService` — survives WS reconnect within the same session).
- **Lifetime:** session-lifetime. Reset only on `session_end`. WS disconnect/reconnect within a session preserves the counter; reconnect with a NEW `sessionId` resets it.
- **Mint point:** at audio-intent creation time on iOS. Specifically:
  - For confirmations/corrections from `result.confirmations[]` (server-side bundled): iOS mints `audioSeq = nextSeq()` when the WS `extraction` event arrives, BEFORE calling `APIClient.proxyElevenLabsTTSStreaming`.
  - For fast-path (Stage 4 only): iOS mints `audioSeq = nextSeq()` when the regex match fires, BEFORE the POST to `/api/voice-latency/regex-fast-tts`.
  - For ask_user TTS (Stage 5): iOS mints when the `ask_user_started` event arrives.
- **Wire propagation:**
  - HTTP requests carry `audioSeq` as a header: `X-Voice-Latency-Audio-Seq: <uint64>`.
  - Backend echoes in the response header `X-Voice-Latency-Audio-Seq` (same value, untouched).
  - Backend stores in suppression reservation record (Stage 3+4 path only).
  - `voice_latency_ack` over WS carries `{correlationId, audioSeq, outcome, hrtimes}`.
  - Server telemetry includes `audioSeq` on every span for cross-correlation.
- **AlertManager queue rules:**
  - Track `lastScheduledSeq` and `lastPlayedSeq` per session.
  - On incoming audio response: if `incoming.audioSeq < lastScheduledSeq` AND the queued audio is for the SAME `{boardId, circuit, field}` → drop. (Newer audio for same logical slot wins.)
  - Different `{boardId, circuit, field}` → queue normally regardless of seq.
- **Reconnect handling:** on WS reconnect with same `sessionId`, AlertManager's `lastScheduledSeq` and `lastPlayedSeq` are PRESERVED. The seq counter does NOT reset.
- **Test fixtures:** `voice-latency-audioseq-*.test.js` covers (a) ordered playback within a session, (b) stale-drop for same-slot, (c) different-slot bypass, (d) reconnect preserves seq, (e) new-session resets seq.

**Residual risk acknowledged:** §16 row 1 — once audio is delivered to iOS and `scheduleBuffer()` has been called, it WILL play to completion (Apple's audio engine doesn't have a "cancel scheduled buffer" primitive). audioSeq prevents *newer* audio being preempted by stale, but does NOT prevent *older* audio finishing before newer arrives. In practice the fast-path is faster, so older Sonnet audio rarely arrives after newer fast-path audio. Telemetry tracks the `dropped_stale` outcome count to verify.
```

### §A.5 — Add new structured field-test capture sheet (per Codex v3 NI5)

```
## 5.6 Field-test capture sheet (Stage 2 assessment gate)

For each of the ~5 cert sessions Derek runs during the Stage-2 assessment, capture in `STAGE2_FIELD_TEST/session_<id>.md`:

| Field | Value | Notes |
|---|---|---|
| Session ID | UUID | from telemetry |
| Date / time start | ISO 8601 | |
| Date / time end | ISO 8601 | |
| Device | iPhone 17 Pro / iPad Air / other | |
| Network | Wi-Fi / 4G / 5G / cellular fallback | |
| Audio route | built-in / AirPods / BT headset / wired | (per Codex angle #7) |
| Certificate type | EICR / EIC | |
| Backend commit SHA | from `voice_latency.startup_log` | |
| iOS build number | from app | |
| Flags effective | `VOICE_LATENCY_STREAM_CONFIRMATIONS=true`, others false | |
| **Telemetry — auto-captured** | | |
| Total confirmations | count | |
| Total corrections | count | |
| Audible-confirmation P50 latency | ms | from `voice_latency.jsonl` analyser |
| Audible-confirmation P95 latency | ms | |
| Max latency observed | ms | |
| **Subjective — Derek logs as he goes** | | |
| Count of confirmations that felt late enough to interrupt flow | int | |
| Count of "I wondered if it heard me" moments | int | |
| Count of confirmations that clipped next utterance | int | |
| Count of confirmations that arrived AFTER inspector moved on | int | |
| Free-text verdict | OK / borderline / too slow | one short sentence |
| **Other notes** | | flag anything weird |

Total per session: 5 minutes after-the-fact logging. Pattern across 5 sessions → Derek's decision (acceptable / borderline / proceed).
```

### §A.6 — Replace PLAN_v3 §8 intro with explicit dependency note (per Codex v3 NI6)

```
## 8. Stage 5 — ask_user streaming (independent of Stages 3+4)

**Stage 5 ships in BOTH the 9.1A (minimum) and 9.1B (full) rollouts.** Stage 5 depends on:

- **Stage 1b's chunked HTTP client** (`proxyElevenLabsTTSStreaming`) — for the audio delivery path.
- **Stage 2's `ElevenLabsStreamClient`** — for the vendor connection.
- **Stage 2's `StreamingAudioPlayer`** — for iOS playback.

Stage 5 does NOT depend on:
- Stage 3 (`voice-suppression-store`) — ask_user has no suppression contract (each question is unique to the turn).
- Stage 4 (`/api/voice-latency/regex-fast-tts` + fast-eligibility) — orthogonal path.
- Stage 4's race catalogue R1–R8 — none of those races apply to ask_user.

Rest of §8 carries from PLAN_v3 §8 unchanged.
```

### §A.7 — Replace PLAN_v3 §3.G scenario library with stage-split suites (per Codex v3 NI4 + Claude v3 NI2)

PLAN_v3 §3.G listed 15+8+4 = 27 scenarios in a flat structure. Replace with suite-split layout:

```
**`tests/fixtures/voice-latency-scenarios/`** layout:

  protocol/        — 4 scenarios (capability handshake, missing source, etc.)
                     — required for BOTH 9.1A and 9.1B rollouts
                     — run via `npm run voice-test -- --suite protocol`

  stage2_streaming/ — 5 scenarios (PCM playback timing, chunked HTTP receive,
                     mic-pause-on-first-frame, cost-on-text-sent, kill switch)
                     — required for BOTH rollouts
                     — `npm run voice-test -- --suite stage2_streaming`

  stage3_suppression/ — 3 scenarios (TTL expiry, board-switch invalidation,
                       field_corrected invalidation)
                       — required ONLY for 9.1B rollout
                       — `npm run voice-test -- --suite stage3_suppression`

  stage4_fast_path/ — 12 scenarios (8 race fixtures R1–R8 + 4 functional
                     including flux_misrecognition_socket_one,
                     multi_candidate_rejection, pending_ask_no_fast_confirm)
                     — required ONLY for 9.1B rollout
                     — `npm run voice-test -- --suite stage4_fast_path`

  stage5_ask_user/  — 3 scenarios (split-unicode escape, abort-mid-stream,
                     normal question flow)
                     — required for BOTH rollouts
                     — `npm run voice-test -- --suite stage5_ask_user`

Total: 27 scenarios across 5 suites. Default `npm run voice-test` runs all.
Default for 9.1A path: `npm run voice-test -- --suite protocol,stage2_streaming,stage5_ask_user` (12 scenarios).
```

### §A.8 — Update §16 row 4 (per Codex v3 NI2)

Replace row 4 of the 22-row Codex angles table:

```
| 4 | ask_user + pending_write interrupted by fast confirmation | Eligibility step 4 rejects when KNOWN pending ask doesn't match candidate (Stage 4 path only). | R4 race test (9.1B only) | **Honest residual:** future Sonnet ask_user that emerges AFTER fast-path speaks cannot be predicted by iOS regex. User hears fast confirmation followed by clarifying question. Accepted UX trade-off under Strategy B (locked decision 1.20). Telemetry tracks `fast_then_ask_user_emerged`. NOT a mechanically corrected path. N/A in 9.1A rollout. |
```

### §A.9 — Update §16 rows: mark Stage-4-only mitigations

Add "**Full path only; N/A in 9.1A**" suffix to the Residual column for rows: 1 (audioSeq for fast-path overtaking — Stage 4 only context), 4 (already updated above), 21 (fast-TTS bypassing Stage 6 guards), 22 (voice drift via pool — multi-context only).

### §A.10 — Replace PLAN_v3 §5.3 cost-tracker accounting with split contract

PLAN_v3 §5.3 had `recordElevenLabsStreamingUsageForSession(sessionId, characterCount, outcome)` accepting outcome `{started, completed, cancelled, failed}` but called at synthesising-transition (before terminal is known). Replace with two-call split:

```
## 5.3 Streaming cost-tracker accounting (split, per Codex v3 NI3)

`src/extraction/cost-tracker.js` extension — TWO calls per synth, not one:

**Call 1 (always, on text-sent to vendor — `synthesising` reservation transition):**
```js
recordElevenLabsStreamingStarted(sessionId, characterCount, correlationId)
// Increments billable `chars_started` exactly ONCE per correlationId.
// Idempotent: duplicate call with same correlationId is a no-op.
```

**Call 2 (always, on terminal state — `sent_to_client | cancelled | synth_failed`):**
```js
recordElevenLabsStreamingTerminal(sessionId, correlationId, terminal)
// terminal ∈ { 'completed', 'cancelled', 'failed' }
// Increments terminal counter ONLY. Adds NO billable chars (call 1 already did that).
// Idempotent: duplicate calls with same correlationId are no-ops.
```

**Billing semantics:**
- `chars_started` = total billable from ElevenLabs perspective (they bill on text-accepted).
- `chars_completed + chars_cancelled + chars_failed = chars_started` (invariant).
- Daily cost reconciliation (§9.3) compares `chars_started` (ours) vs vendor-reported (theirs).

**Test surface:**
- Normal completion: started → completed. Charged once, terminal=completed.
- Client abort after text-sent: started → cancelled. Charged once, terminal=cancelled.
- Vendor error after first byte: started → failed. Charged once, terminal=failed.
- Duplicate terminal callback: terminal call is idempotent.
- Multiple concurrent synths same session: each correlationId tracked independently.
```

### §A.11 — Smaller fixes (NN1–NN3)

- **§18:** Remove "Derek answers Open Questions §12" line. Q1–Q11 all resolved. Replace with: "Derek approves PLAN_v4. Stage 0 begins."
- **§4.7/§4.8:** Replace "Stage 1a/1b independent verification gate" wording with "sequential verification gates: 1a backend lands first, then 1b iOS lands against 1a."
- **§4.4:** Drop `(TBD per implementation)` line-number column. Replace with function-name anchors: `speakResponse`, `speakBriefConfirmation`, `speakCriticalNotification`, `askSlotCount`, `askSlotContent`. Note that some of these are private and route through `speakWithTTS` (line 1030) — implementation should add the source-thread at the originating call site, not at the funnel.

### §A.12 — Replace PLAN_v3 §13 with branch-correct exit criteria

```
## 13. Exit criteria (post-PLAN_v4)

Two tiers, decided at the Stage 2 assessment gate (locked decision 1.21):

### 13.1 Minimum-Viable Sprint Exit (9.1A rollout — Stages 0+1+2+5+6)

If Derek's post-Stage-2 assessment says "acceptable" or "defer":

- All Stage 0 gates A, B, C, D, E, F, G documented (incl. measured tunables in `STAGE0_RESULTS_TUNING.md`).
- Stage 1a (backend protocol) + Stage 1b (iOS protocol) commits landed with verification gates passed.
- Stage 2 (streaming confirmations) commits landed. Telemetry P50 ≤ 3.0 s cold / ≤ 2.5 s warm (if 0.F passed).
- Stage 5 (ask_user streaming) commits landed. Question P50 ≤ 1.4 s.
- Field-test capture sheet completed for 5 sessions (§A.5).
- Transcript-replay harness `protocol + stage2_streaming + stage5_ask_user` suites green in CI (12 scenarios).
- Documentation: `docs/reference/voice-latency.md` covers shipped subset.

**Honest framing:** audible-confirmation latency improved ~17–33% (3.0 s → 2.5 s warm). Streaming infrastructure shipped. Suppression machinery + fast-path NOT shipped. Future sprint can return to it if telemetry reveals the need.

### 13.2 Full Sprint Exit (9.1B rollout — Stages 0+1+2+3+4+5+6)

If Derek's post-Stage-2 assessment says "still too slow, proceed":

- Everything in 13.1 PLUS:
- Stage 3 (suppression) + Stage 4 (regex-fast) commits landed.
- All 8 race fixtures R1–R8 pass deterministically.
- Stage 4 field-test sample of ≥10 reads per fast-eligible field per audio route × 4 routes shows ≥80% reach `fast_heard`; suppression rate ≥90% of `fast_heard`.
- P50 audible-latency on fast-eligible turns: ≤ 1,200 ms cold / ≤ 700 ms warm.
- Transcript-replay harness ALL 27 scenarios green in CI.

**Honest framing:** headline target achieved on regex-eligible turns. Sonnet-narrated turns still bounded by Sonnet TTFT floor (Stage 2 numbers above).

Either exit is a valid sprint outcome. Don't grade the sprint on which branch was taken — grade it on whether the right decision was made at the gate.
```

---

## §B. What's unchanged from PLAN_v3 (explicit list, for the executor)

Carry forward verbatim:

- §0 (PLAN_v3's "what changed vs v2")
- §1 rows 1.1–1.20 (locked decisions)
- §2 (latency budget — already honest)
- §3.A–§3.F (Stage 0 measurement gates A–F)
- §3.G (transcript-replay harness — but with §A.7 scenario-split applied)
- §4.1–§4.6 (telemetry, flags, capability handshake, source field, field_corrected emission, session entry)
- §4.7 + §4.8 (Stage 1a + 1b commit lists — but with §A.11 "sequential gates" wording)
- §5.1 (StreamingAudioPlayer — but with §A.4 audioSeq spec)
- §5.2 (backend stream-input for confirmations)
- §5.3 (cost-tracker — replaced by §A.10)
- §5.4 (Codex angles addressed)
- §5.5 (Stage 2 commits)
- §6 (Stage 3 — server-side suppression) — **applies only in 9.1B branch**
- §7 (Stage 4 — fast-path) — replaced intro per §A.2, applies only in 9.1B branch
- §8 (Stage 5) — intro replaced per §A.6
- §10 (testing strategy) — §10.6 scenarios split per §A.7
- §11 (documentation)
- §12 (open questions — all resolved including new Q11 parked tick)
- §14 (risk register)
- §15 (references — add `claude-review-v3.md`, `codex-review-v3.md`, `PLAN_v3.md`)
- §16 (22-row traceability — with §A.8 + §A.9 updates)
- §17 (NITs addressed)

---

## §C. Approval & next steps

- [ ] Derek reads PLAN_v4 (this file).
- [ ] Derek approves OR requests revisions.
- [ ] On approval: Stage 0 begins. Six measurement gates (A–F) plus transcript-replay harness (G) before any Stage 1 commits.

Per Codex v3's diminishing-returns assessment + Claude v3's "stop reviewing, start building": **no PLAN_v5 unless v4 amendments themselves materially change scope**. The remaining IMPORTANT items from v3 reviews are 30-minute-and-5-minute fixes that land naturally during Stage 0.G implementation.

---

## §D. Summary — total review investment

| Pass | Reviewers | BLOCKERs caught | IMPORTANTs caught | Resulting plan |
|---|---|---|---|---|
| Draft | — | — | — | PLAN.md |
| Review 1 | Claude + Codex | 7 | 20 | PLAN_v2.md |
| Review 2 | Claude + Codex | 2 | 9 | PLAN_v3.md |
| Review 3 | Claude + Codex | 0 (Claude) / 2 (Codex) | 2 / 6 | PLAN_v4.md (this file) |
| **Total** | — | **9 BLOCKERs caught** | **35 IMPORTANTs caught** | **0 lines of code shipped** |

If any of these had reached production: 2+ days of TestFlight + field-test debugging per occurrence. Pattern paid for itself many times over.

Stage 0 starts next session.
