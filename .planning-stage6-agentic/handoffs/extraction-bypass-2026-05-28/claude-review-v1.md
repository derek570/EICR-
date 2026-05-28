# Claude self-review v1 — extraction-bypass PLAN.md

## Verdict
NEEDS REWORK
4 BLOCKERs, 6 IMPORTANT, 3 MINOR

The plan rests on two assumptions that the codebase contradicts: (1) "iOS pushes `job_state_update` after every regex pre-apply" — it doesn't, regex pre-apply never calls `notifyJobStateChanged` (`DeepgramRecordingViewModel.swift:3763–4083`); (2) "the SoI in the cached prefix is 10–15k tokens" — the file is 9.98 KB on disk, roughly 2.5–3.5k tokens, an order of magnitude smaller than the saving model assumes. Both Phase A and Phase B's saving estimates collapse when these are corrected. Additional blockers around conversation-history coherence and the batching layer that the plan never names.

## Findings

### BLOCKER 1 — iOS does NOT push `job_state_update` after regex pre-apply

`DeepgramRecordingViewModel.applyRegexMatches()` (Sources/Recording/DeepgramRecordingViewModel.swift:3763–4083) mutates `jobVM.job`, `liveFillState.job`, calls `jobVM.save()`, and returns. It never calls `serverWS.sendJobStateUpdate(...)` and never calls `notifyJobStateChanged(...)`. The only callers of `sendJobStateUpdate` in the iOS code are the circuit-create path (5509), the board-ops apply path (5793), and external `notifyJobStateChanged` (6977) — none of which fire on a regex-only utterance. This means today's `regexResults` carries only field NAMES (see `buildRegexSummary` in `TranscriptProcessor.swift:199–208`, which builds `[{field: "supply.ze"}]` with no value except for postcode), the iOS-applied VALUE never reaches the server's stateSnapshot, and the user-message phrasing in `eicr-extraction-session.js:2346` ("The next job_state_update will reflect the values") is already aspirational, not factual. Plan §2.4's "log query to confirm" will not just be a verification step; it will fail. Phase A then has a real data-loss path: a bypassed utterance leaves stateSnapshot with the field still blank, the next-turn Sonnet that follows sees a blank field and either re-asks ("what's the Zs for circuit 3?") or moves on without the reading ever existing on the server side. The §2.2A merge step the plan calls a "critical dependency" only fires when iOS pushes — and iOS doesn't push for regex hits.

**Fix:** Phase A must ship the server-side regex applier (`A.1`) UP FRONT, not as a contingency. Apply regex values directly into `session.stateSnapshot` on bypass — mirror the existing `_mergeIncomingJobStateIntoSnapshot` precedence rules (FACT overwrites, READING fills-empty). Alternatively (better): change iOS to call `notifyJobStateChanged(reason: "regex_apply")` at the bottom of `applyRegexMatches()` when `changed == true`. The 250 ms debounce already handles burst rates. Either way, do not ship Phase A behind a "verify and decide" gate — the verification has been done and the answer is no.

### BLOCKER 2 — Bypassed turns leave `conversationHistory` with holes Sonnet can rationalise away

`EICRExtractionSession.conversationHistory` is only appended inside `_extractSingle` (`eicr-extraction-session.js:2074-2077`). If a turn is bypassed, the user transcript is not added. On the NEXT Sonnet turn the model sees: (a) a stateSnapshot that may now have new values (assuming BLOCKER 1 is fixed), (b) a turn-history that skips the bypassed utterance entirely, (c) any post-bypass utterance carrying a "DO NOT extract these fields" prompt that names fields Sonnet has no prior context for. Two failure modes: (i) Sonnet re-emits a `confirmation` or re-asks about the bypassed reading because it sees the snapshot value but no record of how it arrived, and (ii) `reviewForOrphanedValues()` (line 3494) — explicitly named in the plan as a safety net — scans `conversationHistory` for orphaned readings and CANNOT see anything that wasn't pushed there. The plan's claim in §0.2/section 5 that this catches anything bypassed in error is false.

**Fix:** On bypass, append a synthetic exchange to `conversationHistory`:
```
{role: 'user', content: [{type: 'text', text: '[BYPASSED REGEX-CLEAN] ' + transcriptText}]}
{role: 'assistant', content: [{type: 'text', text: '{"extracted_readings":[<regex hits>],"confirmations":[],"questions_for_user":[]}'}]}
```
This keeps the history coherent, lets `reviewForOrphanedValues` see what was caught, and lets `addMidConversationBreakpoints` keep working. Yes, this adds tokens to the next cached-prefix turn — but the bypass already saved a full Sonnet round, so this is still a net win. Also: explicitly state that `reviewForOrphanedValues` is NOT a safety net for true-positive bypasses where regex caught the wrong field — that's a fundamentally different failure mode that needs its own mitigation (probably a Sonnet check-in at session-end, since `reviewForOrphanedValues` is called from a periodic timer the plan doesn't reference).

### BLOCKER 3 — Per-utterance bypass interacts incorrectly with the 2-utterance batch buffer

`extractFromUtterance` (`eicr-extraction-session.js:1845`) does NOT call Sonnet per utterance — it buffers up to `BATCH_SIZE = 2` (line 43) or waits `BATCH_TIMEOUT_MS = 2000`. The plan's per-turn saving math ($0.018 per skipped Sonnet round, 30–50% of turns regex-clean) is assuming "skipped utterance = skipped Sonnet call", which is wrong by roughly 2x. If a regex-clean utterance lands while an extractable utterance is already in the buffer, you must NOT silently drop the regex-clean utterance — the batched Sonnet call needs that combined context. Conversely, if both utterances in a batch are regex-clean, you save one Sonnet call, not two. The plan doesn't describe how the bypass interacts with the buffer state at all.

**Fix:** Choose one of two routes and document it: (a) bypass at the `sonnet-stream.handleTranscript` layer BEFORE the message reaches `extractFromUtterance` — never enters the buffer (cleanest, but you must still update stateSnapshot per BLOCKER 1); (b) bypass at the `_processUtteranceBatch` layer — when ALL batched utterances are regex-clean, skip the API call; when MIXED, fall through to Sonnet with the regex-clean utterance still included in `combinedText` so context isn't lost. Either way the saving estimate needs a correction factor of roughly 0.5 because some "regex-clean" utterances were never going to fire Sonnet alone in the first place. Rewrite §5's cost table with this correction.

### BLOCKER 4 — Phase B saving estimate uses a SoI token count that is ~4–6x too large

Plan §3.1 claims "SoI is 99 inspection items… **10–15k tokens**". The actual file is `wc -c` = 9,980 bytes (136 lines) at `config/prompts/schedule-of-inspection-bs7671-eicr.md` — at the standard ~4 chars/token English ratio that's roughly **2.5k tokens**, not 10–15k. The 35k total cache reads/turn quoted in §0 are dominated by the agentic system prompt (25k bytes), the cached state snapshot, and the messages window — not the SoI. Moving SoI behind a tool will save closer to ~5–8% of cache reads/turn, not 25–30%. The combined-saving model in §5 ("23k tokens read after Phase B" vs "35k before") doesn't survive this correction.

**Fix:** Tokenise the actual file (`anthropic.tokenize` or a real tokenizer) BEFORE finalising Phase B's saving claim. If the real number is 2–3k tokens, decide whether the extra round-trip latency from the lookup tool + the BLOCKER 5 conversation-history token cost is worth the saving at all. Phase B might still be net-positive — but the cost model has to be honest about it, and the "Combined: $0.12–$0.30/session" headline needs to come down materially. Also: §3.6 risk section needs a 7th canary metric — re-emitted observations not finding their schedule_item.

### IMPORTANT 1 — Tool-result tokens land in conversation history and get cached on subsequent turns

`stage6-tool-loop` (and the established pattern in this codebase) appends the tool_use + tool_result pair to the messages window so Sonnet can reason against prior tool calls. A `lookup_inspection_item` that returns ~200 tokens of SoI text is then sitting in the cached prefix on the NEXT turn — i.e. you pay for it on cache reads from then to the end of the session (or until cache TTL expires). On a 24-turn session with 5–8 observation turns, that's potentially 1.5–2k of accumulated tool_result tokens replayed against each remaining turn. The plan never mentions this. The net saving could be substantially smaller than §5 suggests after the second or third observation in a session.

**Fix:** Either (a) elide tool_result content from the cached prefix after the next Sonnet turn (replace with `<tool_result truncated>` once the result is no longer needed), or (b) accept the erosion and model it explicitly in §5 — show the saving curve as a function of observation count. Honest mid-range estimate probably drops to ~$0.03–$0.05/session for Phase B.

### IMPORTANT 2 — Closed-enum trigger lexicon has no canonical home

The lexicon in §2.3 duplicates roughly half of `pre-llm-gate.js:36–148`'s `TRIGGER_WORDS` set but adds "code 1/2/3", "concern", "hazard", "unsafe", "scorched", etc. that gate doesn't have. The plan says "stored as a Set in `src/extraction/observation-triggers.js`" but the iOS port for Phase C is hand-waved ("port via shared-types or duplicate with a comment"). There is no `packages/shared-types` constant for this today and the iOS app has no auto-sync mechanism for backend JSON enums. If the backend lexicon evolves (and it will — false-positive triage is the canonical reason these things grow), iOS will silently drift. Phase C's pre-baked TTS firing on iOS-side triggers that the backend bypass DOESN'T recognise is the worst outcome: inspector hears "Noting that…", Sonnet IS called, observation gets emitted via the normal path — fine. The opposite (backend bypasses because backend lexicon was stricter, no observation TTS plays) means data loss.

**Fix:** Put the canonical list in `packages/shared-types/src/observation-triggers.ts` exporting a `readonly string[]`. Backend imports it; iOS embeds a build-time copy (existing pattern — `field_schema.json` does this). Add a CI check that fails if the iOS bundled copy diverges from shared-types, same shape as the `field_schema.json` audit. The plan should also state the policy: "additions to the lexicon may NOT ship to backend alone — must ship in lockstep with an iOS build". If the canonical list lives only on the server, undo Phase A's bypass conditional on the lexicon and use a server-only check.

### IMPORTANT 3 — Phase A telemetry baseline is unanchored

§0 claims "30–50% of turns are regex-clean" and §6.2 sets abort threshold at "bypass_rate < 10%". Neither has a CloudWatch baseline today — there's no existing log line that tells you what fraction of forwarded transcripts had `regexResults.length > 0` AND no observation trigger word AND no question lead-in. The closest existing signal is `voice_latency.gate_blocked` reasons + the pre-LLM gate's pass-through stats, but those don't break down the population by the §2.1 eligibility rules. Without a baseline, you have no idea whether 30% is right or whether real-world is closer to 5%.

**Fix:** Add a passive telemetry counter FIRST (Day 1 morning), no bypass behaviour — just compute `shouldBypassSonnet(...)` on every forwarded transcript and log the verdict with reason. Run for one field day. Then decide whether to ship the actual bypass. If the real rate is <15%, this whole phase saves a fraction of what was modelled and the rollout risk-vs-reward might not pencil out.

### IMPORTANT 4 — Confirmation TTS on bypass: silent acknowledgement is a behavioural regression

When Sonnet processes a reading today, it commonly emits an entry in `confirmations[]` that drives an audible "Zs 0.35 for circuit 3, got it" or similar, depending on confirmation mode settings (`sonnet-stream.js:3288–3295`). On bypass, no Sonnet call means no confirmation array. The plan does mention this in §2.5's "ack only" and §4 (TTS bridge), but Phase C is iOS-only and ONLY targets observations — not regex-clean readings. So between Phase A shipping and Phase C shipping, a regex-clean reading produces a `regex_fast_tts` ACK *if and only if* the utterance matches the strict "Circuit N <field> <value>" pattern (5-field whitelist, `regex-fast-eligibility.js:47`). For all other regex hits — "Ze is 0.31", "supply is TN-C-S", "main switch is BS EN 60947", "bonding water" — bypass means SILENCE. That's a real UX regression versus today's Sonnet-emitted confirmation.

**Fix:** Either (a) gate Phase A bypass on regex-fast-TTS eligibility (only bypass when the strict-shape fast-path ACK will fire — narrows the bypass-rate population but preserves UX), or (b) extend the regex-fast-TTS path to cover more field types and ship that first. Don't ship a silent bypass for the 80% of regex hits that aren't fast-path-eligible. Document the chosen path explicitly — the plan handwaves "ack only" without specifying what the inspector hears.

### IMPORTANT 5 — Phase B rollback story is incomplete

§3.5 says "deploy with `SOI_TOOL_ENABLED=false` default (full SoI in prompt unchanged)". But if `SOI_TOOL_ENABLED=false` AND `lookup_inspection_item` is in the tool schema, Sonnet will sometimes call it anyway (model curiosity, partial cache, mid-session flip). The dispatcher then runs against a possibly-stale assumption that the in-prompt directory is also live. Worse: the prompt rewrite in §3.3 explicitly removes the full SoI text from the cached prefix when `SOI_TOOL_ENABLED=true`, but the rollback path needs the prompt to still include it. So the rollback flip is actually TWO things: prompt build path + tool schema gating. Plan needs both. And the `EICR_AGENTIC_SYSTEM_PROMPT` is computed at module init (`eicr-extraction-session.js:899`) — a runtime env flip won't reach it without a process restart or an explicit build-on-demand path.

**Fix:** Rewrite §3.5 to specify (1) tool schema is conditionally included based on env flag at construction time of the tool array per-session, (2) `EICR_AGENTIC_SYSTEM_PROMPT` is computed lazily or at session-start, not module-load, so env-flip works without redeploy, (3) document explicitly that flipping the env requires task-def update + ECS service redeploy, OR build the lazy-load path. Choose. Plan §6.2 abort criteria should also include "Sonnet calls `lookup_inspection_item` with SOI_TOOL_ENABLED=false" as a P0 abort.

### IMPORTANT 6 — Bypass eligibility list omits chitchat-pause state

§2.1 lists 7 eligibility checks. It doesn't list "session is not in chitchat-pause". Chitchat-pause logic at `sonnet-stream.js:976` already special-cases regex hits (they wake the session from pause). A bypass that triggers BEFORE the chitchat wake-on-regex check fires would short-circuit a wake event — the session stays paused even though the inspector just dictated something extractable. Probably benign in practice (next Sonnet call will pick up the stateSnapshot) but it's a behavioural change to a recently-shipped subsystem.

**Fix:** Add explicit check #8 to §2.1: "session not in chitchat-paused state OR bypass also fires the wake-on-regex side-effect". Cleanest implementation: bypass runs AFTER the chitchat-wake branch in `sonnet-stream.js:973–1029`, so the wake side-effect still happens, only the downstream Sonnet call gets skipped.

### MINOR 1 — Phase C false-positive rate threshold isn't supported by data

§6.2 abort threshold "False-positive rate > 20%". No baseline tells you what's normal for this metric — there's no equivalent today. The whole point of the bridge is to play optimistically so 20% false positives by some definitions might be entirely fine (cheap audio, no real cost). Acceptance criteria for §4.4 ("trigger word in a non-observation context — acceptable") and abort criteria for §6.2 contradict each other.

**Fix:** Pick one: either false positives are acceptable (no upper bound, the bridge is cheap and an inspector hearing "Noting that…" with no follow-up is mildly weird but harmless) or they're not (specify what threshold and why). The current text says both.

### MINOR 2 — §0.2 saving table includes Phase C UX value with $ cost of zero — meaningless line item

Phase C row of §0.2 says "$0.00 cost, +UX". It's not really a saving and shouldn't be in a saving table; readers might add the high-confidence "$0.00" line into a total and lose the qualitative point. Move Phase C's value statement into prose ("Phase C costs nothing and primarily improves perceived latency").

### MINOR 3 — Telemetry naming inconsistency

§2.5 logs `voice_latency.sonnet_bypass` but the existing telemetry namespace is `voice_latency.gate_blocked` (gate verdict), `voice_latency.fast_path_*` (fast-TTS path). For grep-ability across the codebase, prefer `voice_latency.bypass.applied` / `voice_latency.bypass.rejected_*` and align field names with existing `gate_blocked` (which uses `reason` + `had_pending_ask` etc, not the proposed `regexFieldsBypassed`). Matches the pre-LLM gate's convention so CloudWatch Insights queries don't need two grammars.

**Fix:** Rename per existing convention; mirror `gate_blocked`'s key set.

---

## Summary of required changes before ship

1. Acknowledge iOS does not push state on regex pre-apply; ship server-side regex application OR iOS `notifyJobStateChanged` call as part of Phase A's mainline (not contingent).
2. Append synthetic bypassed-turn entries to `conversationHistory` so Sonnet sees the gap and `reviewForOrphanedValues` actually inspects bypassed text.
3. Specify exactly where in the pipeline the bypass sits relative to the BATCH_SIZE=2 buffer and rewrite §5's cost table.
4. Re-tokenise SoI properly; halve Phase B's saving estimate.
5. Address the IMPORTANT findings — at minimum: tool-result caching cost, lexicon canonical home, bypass-rate baseline before flipping, confirmation TTS coverage, runtime env-flip path for Phase B, chitchat-pause interaction.

After those: Phase A is implementable but the saving floor is closer to $0.04/session, not $0.14. Phase B is implementable but probably $0.01–$0.03/session, not $0.06. Phase C unaffected.
