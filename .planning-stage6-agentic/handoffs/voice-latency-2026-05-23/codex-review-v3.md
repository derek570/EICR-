# Codex review v3 — PLAN_v3.md

## Verdict

Revise, but do not run another broad research pass. PLAN_v3 is close enough that the next revision should be a tight PLAN_v4 patch, not a rethink.

The amended decisions are mostly sound, but the conditional Stage 4 change was not propagated through the executable plan. The biggest issue is product/sequence coherence: PLAN_v3 makes Derek decide after Stage 3, yet Stage 3's main value is suppressing duplicates created by Stage 4. If Stage 4 is skipped, 13.1 ships a marginally faster confirmation path plus ask_user streaming, while one whole suppression stage is mostly proof that nothing is being suppressed.

I would not start implementation until the Stage 4 gate is moved or Stage 3 is explicitly scoped as conditional/minimal.

## Counts

- NEW BLOCKERs in v3: 2
- NEW IMPORTANTs in v3: 6
- NEW NITs in v3: 3
- v2 BLOCKER fixes re-verified against v3: 2 of 2 fixed at plan level
- v2 PARTIAL items re-verified: 1 fixed, 2 still partial/residual

## Previous findings re-verification

| Finding | v3 status | Verification |
|---|---|---|
| Claude v2 NB1: `field_corrected` wire shape | FIXED | v3 pins snake_case `previous_value` and `reason`, matching `CertMateUnified/Sources/Services/Stage6Messages.swift:147`. |
| Codex v2 NB1: iOS `.responseData` buffers whole MP3 | FIXED at plan level | v3 adds Stage 1b commit 1b.6 to replace the current buffered `APIClient.proxyElevenLabsTTS`; actual code still uses `.responseData` at `CertMateUnified/Sources/Services/APIClient.swift:855`, which is expected pre-implementation. |
| Codex v2 B2 PARTIAL: no monotonic turn/audio lane | PARTIAL | v3 adds an iOS-side `audioSeq`, but does not define who mints it, whether it is sent to the backend, whether the suppression reservation stores it, or how it survives WS reconnect with the same session. See NEW IMPORTANT 1. |
| Codex v2 B3 PARTIAL: future ambiguity | PARTIAL, honestly accepted in some places | §0 and §12 accept Strategy B / residual risk. §16 row 4 is still inherited from v2 and says active-ask mismatch is covered, which does not cover future Sonnet ask_user emergence. See NEW IMPORTANT 2. |
| Codex v2 NI4: Stage 1 mini-sprint | MOSTLY FIXED | Splitting 1a backend and 1b iOS is a real improvement. Strictly, 1b's field test depends on 1a backend behavior already being deployed, so the gates are sequential rather than independent, but that is acceptable. |
| Codex v2 NI5: cost tracker streaming | PARTIAL | Charging on text-sent is right. The terminal counters are still underspecified because the function is called before the terminal outcome is known. See NEW IMPORTANT 3. |
| Codex v2 NI3: Stage 0.F under-scoped | FIXED with caveat | One full day plus seven concrete criteria is enough if failure is allowed at end-of-day. The multi-context endpoint remains undocumented enough that "one day" must mean "characterise or fail", not "extend until understood". |

## NEW BLOCKERs

### NB1. The 13.1 minimum-viable exit is not a coherent enough product/engineering slice

**Where:** PLAN_v3 §1.21, §5, §6, §7, §13.1.

**Problem:** The plan says Stage 4 is conditional after Stage 3, but Stage 3 is explicitly justified as machinery for Stage 4:

- §5 says Stage 2 "lands the streaming TTS machinery AND the suppression machinery for Stage 4 to leverage."
- §13.1 says Stage 3 is "proven against zero sources of duplication (suppression rate = 0% in steady state)".
- In the Stage 4-skipped branch, there is no fast-path duplicate source. The only remaining suppression target is accidental repeated Sonnet confirmations within the TTL, but current backend confirmation generation already builds confirmations from committed per-turn writes and iOS already has some confirmation/correction dedupe paths. That is not enough value to justify a full Stage 3 before the Stage 4 decision.

The minimum viable exit would deliver:

- Stage 2: marginal confirmation latency improvement, honestly framed as ~17-33%.
- Stage 5: ask_user streaming, useful and independent.
- Stage 3: mostly idle infrastructure whose success criterion is "did not suppress anything."

That is an unhappy compromise. It pays for Stage 4's race/suppression foundation before deciding whether Stage 4 is worth doing.

**Fix:** Move the Derek decision gate to after Stage 2 field telemetry, before Stage 3. Then either:

1. If Stage 2 + Stage 5 is acceptable, skip Stage 3 and Stage 4. Minimum exit becomes Stages 0 + 1 + 2 + 5 + 6.
2. If still too slow, execute Stage 3 + Stage 4 together as the fast-path slice.
3. If you want a tiny Stage 3 regardless, re-scope it to passive telemetry/contract scaffolding only, with no suppression-store rollout claim in 13.1.

### NB2. The carried rollout plan still assumes Stage 4 ships

**Where:** PLAN_v3 §9 says "carried"; inherited PLAN_v2 §9.1 steps 1, 8, 9; PLAN_v3 §16.

**Problem:** §9.1 is no longer executable with conditional Stage 4:

- It says "Land Stages 1-4 on `main`" before rollout. That contradicts §1.21 and §13.1, where Stage 4 may be skipped.
- It later ships iOS Build N+1 with `regexFastEnabled=true` and flips `VOICE_LATENCY_REGEX_FAST_TTS=true`. That has no place in the 13.1 path.
- It requires the four-route Stage 4 field test, but §13.1 can close without Stage 4.
- §16 row 1 says "Fast-path overtakes older Sonnet MP3" has residual "None - newer audio always wins"; in the 13.1 path this row is N/A, and in the full path v3 §0 already admits old audio already delivered to iOS cannot truly be cancelled.

This is not just wording. Rollout is where flags and TestFlight sequencing become operational. If an implementation agent follows inherited §9.1 literally, they will build/land/enable Stage 4 despite the new conditional gate.

**Fix:** Split rollout into two explicit branches:

- 9.1A minimum rollout: Stages 0/1/2/(optional minimal 3)/5/6 only; no `regexFastEnabled`, no `VOICE_LATENCY_REGEX_FAST_TTS`, Stage 4 rows marked N/A.
- 9.1B full rollout: Stage 3 + Stage 4 fast-path rollout, route tests, R1-R8, fast_heard/suppression metrics.

Also update §16 so every Stage-4-only mitigation is marked "Full path only; N/A in 13.1."

## NEW IMPORTANTs

### NI1. `audioSeq` is still not specified tightly enough to solve stale playback

**Where:** PLAN_v3 §5.1, §5.4, §16 row 1.

v3 says "per-session monotonic `audioSeq` counter on iOS side" and "AlertManager queue checks `incoming.audioSeq < queue.lastPlayedSeq`". That answers the existence of a lane, but not the ownership contract.

Questions still open:

- Is `audioSeq` minted by iOS when an audio intent is created, by the backend reservation, or by response arrival order?
- If iOS mints it, does it attach the seq to both the regex-fast HTTP request and the later Sonnet confirmation playback object?
- Does the backend echo/store it in the suppression reservation and telemetry, or is it purely local?
- What happens on WS reconnect with the same `sessionId`? `ServerWebSocketService.sendSessionStart` currently treats same-session reconnects specially for unknown-message budget; the plan needs the audio lane to survive reconnect too.
- What happens if an older HTTP response completes after a new playback has already begun but before the old response has an assigned seq?

Fix: define `audioSeq` as iOS-owned, session-lifetime, not WS-connection-lifetime. Mint it at audio-intent creation, include it in HTTP payloads/headers and `voice_latency_ack`, store it in server telemetry/reservations, and compare `(sessionId, audioSeq, correlationId)` in AlertManager. If the backend owns it instead, define the server allocation path before ElevenLabs starts and require every response to echo it.

### NI2. Future ask_user ambiguity is accepted, but §16 and §0 overstate the mitigation

**Where:** PLAN_v3 §0 item 12, §1.20, §7 intro, §12 Q9, §14, inherited §16 row 4.

The Strategy B decision is acceptable if Derek accepts the UX risk, but the plan should be precise about the residual. A later Sonnet `ask_user` is not the same as a correction-class TTS. The current code has `ask_user`/question paths in `AlertManager.speakResponse` and backend ask registries; there is no existing "ask_user becomes correction-class TTS" path.

Fix: update §16 row 4 to say:

- Active known pending asks are rejected by eligibility.
- Future Sonnet asks cannot be predicted by iOS regex.
- Residual is accepted under Strategy B.
- Telemetry outcome is `fast_then_ask_user_emerged`.
- User hears fast confirmation followed by a clarifying question; that is a known UX trade-off, not a mechanically corrected path.

### NI3. Streaming cost accounting still conflates charge-time and terminal outcome

**Where:** PLAN_v3 §5.3.

Charging on text-sent is correct. The scenario "cancelled mid-stream" still needs a two-step accounting contract.

Walkthrough:

1. Backend acquires reservation.
2. Backend sends text to ElevenLabs and calls `recordElevenLabsStreamingUsageForSession(sessionId, chars, outcome)`.
3. At that moment the only known outcome is `started`.
4. iOS disconnects or kill switch fires before `isFinal`.
5. The plan wants `chars_started` and `chars_cancelled`, but if the function increments cost and terminal buckets based on its single `outcome` argument, it cannot know `cancelled` at step 2.

Fix: split it into:

- `recordElevenLabsStreamingStarted(sessionId, chars, correlationId)` increments billable `chars_started` exactly once.
- `recordElevenLabsStreamingTerminal(sessionId, correlationId, terminal)` updates `completed/cancelled/failed` counters without adding billable chars again.

Tests should cover client abort after text-sent, vendor error after first byte, normal completion, and duplicate terminal callbacks.

### NI4. Stage 0.G scenario library is still Stage-4-heavy for a 13.1 exit

**Where:** PLAN_v3 §3.G, §10.6, §13.1.

The harness itself is a good addition. The initial scenario list is biased toward Stage 4:

- `normal_number_of_points` is described as "Stage 4 happy path".
- `multi_candidate_rejection`, `pending_ask_no_fast_confirm`, and `race_r1_sonnet_vs_fast` are fast-path eligibility/race tests.
- R1-R8 are included in the full §10.6 suite even though several are Stage 4 only.

For the 13.1 path, the meaningful scenarios are different: legacy behavior unchanged with flags off, chunked confirmation playback, PCM first-frame timings, iOS ack telemetry, cost-on-text-sent, correction-class TTS, ask_user streaming, and no-regression around the known Flux duplicate finals.

Fix: split `npm run voice-test` into suites:

- `protocol`
- `stage2_streaming`
- `stage3_suppression` or `fast_foundation`
- `stage4_fast_path`
- `stage5_ask_user`

Make 13.1 require only the suites that apply to the minimum branch.

### NI5. The post-Stage-3 assessment needs a structured capture method

**Where:** PLAN_v3 §7.

"Derek runs ~5 normal cert sessions" and decides whether it "feels acceptable" is directionally fine, but the plan does not say how to capture enough information to make the decision reproducible.

Fix: add a one-page field-test sheet or script:

- Session ID, route, network, device, certificate type.
- P50/P95 audible confirmation latency from iOS monotonic spans.
- Count of confirmations that felt late enough to interrupt flow.
- Count of "I wondered if it heard me" moments.
- Count of overlaps/clipped next utterances.
- Free-text Derek verdict per session: OK / borderline / too slow.

If the decision gate moves earlier to after Stage 2, keep the same capture structure.

### NI6. Stage 5 does not depend on Stage 4, but the plan should say what it reuses

**Where:** PLAN_v3 §8.

Tracing the current code:

- Current iOS question/response TTS routes through `AlertManager.speakResponse` -> `speakWithTTS` -> `APIClient.proxyElevenLabsTTS`, which currently buffers MP3.
- Stage 1b/2 introduce the chunked HTTP client and StreamingAudioPlayer.
- Stage 5 modifies the Sonnet tool-loop/ask_user path and can reuse the Stage 2 streaming transport/playback.

So Stage 5 is independent of regex-fast Stage 4. That is good. But §8 says only "carried"; it should explicitly state "depends on Stage 1b + Stage 2 streaming transport, not Stage 4 fast-path endpoint or suppression." Otherwise the minimum branch reads ambiguous.

## NEW NITs

### NN1. §18 still says Derek must answer already-resolved open questions

§18 says "Derek answers Open Questions §12", but §12 is marked resolved. Update §18 to "Derek approves PLAN_v3/PLAN_v4" and remove the stale checkbox.

### NN2. Stage 1a/1b "independent verification gate" wording overclaims slightly

1b's real field test depends on the 1a backend parsing capabilities/source/ack. The split is useful, but call them sequential gates: 1a backend gate, then 1b client-against-1a gate.

### NN3. §4.4 still has `(TBD)` line numbers for AlertManager call sites

The actual call sites are visible in `CertMateUnified/Sources/Recording/AlertManager.swift` (`speakResponse`, `speakBriefConfirmation`, `speakCriticalNotification`, `askSlotCount`, `askSlotContent`) and many callers route into `speakBriefConfirmation`. If the plan wants implementation precision, replace `(TBD)` with function-level anchors or drop the line-number column.

## Diminishing returns assessment

We are approaching planning-as-procrastination if this becomes another broad review cycle. The remaining problems are not hidden API unknowns of the v1/v2 sort; they are consequences of one amended decision: Stage 4 is conditional, but the rest of the plan still reads as if Stage 4 is inevitable.

The right next move is a small v4 patch:

1. Move the Stage 4 decision gate earlier, preferably after Stage 2 field telemetry.
2. Make Stage 3 conditional with Stage 4, or reduce it to minimal passive scaffolding in the minimum branch.
3. Split rollout/exit/traceability into minimum vs full branches.
4. Tighten `audioSeq` ownership and cost-terminal accounting.

After that, start Stage 0. Another full-plan review after those edits is probably not worth it unless the edits materially change scope again.

## Recommendation

Revise to PLAN_v4 with the small fixes above, then start Stage 0.

Do not approve v3 as-is because an implementation agent could follow §9.1 and build Stage 4 despite the new conditional gate, and because §13.1 currently treats idle suppression machinery as a valid shipped outcome. The fix is bounded: no new research needed, just branch the plan honestly and move the decision point to where the engineering cost has not already been spent.
