# Extraction-bypass sprint v2 — corrections from Claude self-review v1

**Date:** 2026-05-28
**Iteration:** v2 (folds 4 BLOCKERs + 6 IMPORTANTs + 3 MINORs from `claude-review-v1.md`)
**Sprint scope:** 3 phases, ~4–5 days end-to-end (up from v1's 3–4)
**Branches:** `regex-bypass`, `soi-tool-lookup`, `observation-tts-bridge`

## 0. v1 → v2 changelog

| # | v1 problem | v2 fix |
|---|---|---|
| BLOCKER 1 | iOS never pushes `job_state_update` after regex pre-apply (verified empirically in `DeepgramRecordingViewModel.applyRegexMatches:3763-4083` — no `sendJobStateUpdate` or `notifyJobStateChanged` call). Phase A had a fatal data-loss path. | Phase A now ships a **server-side regex applier** in Phase A.0 (precondition, not contingency). Server applies regex values directly into `stateSnapshot` on bypass, mirroring `_mergeIncomingJobStateIntoSnapshot` precedence. iOS code change deferred (TestFlight cycle). |
| BLOCKER 2 | Bypassed turns leave `conversationHistory` holes → Sonnet either re-asks or re-emits later; `reviewForOrphanedValues` cannot see them. | On bypass, append a synthetic `user` + `assistant` exchange to `conversationHistory` (see §2.5 for exact shape). Preserves coherence, lets `reviewForOrphanedValues` inspect bypassed text, lets `addMidConversationBreakpoints` keep working. |
| BLOCKER 3 | `extractFromUtterance` is buffered (`BATCH_SIZE=2`, 2000ms timeout). Per-utterance bypass interacts incorrectly with this buffer. | Bypass moves UP to `sonnet-stream.handleTranscript` BEFORE the message reaches `extractFromUtterance`. Never enters the buffer. Saving math in §5 corrected for this: bypass-rate is per-utterance, but only utterances that would have *triggered* Sonnet (post-pre-LLM-gate forwards) are in scope. |
| BLOCKER 4 | SoI claimed at 10–15k tokens; actual file is 9,980 bytes ≈ **2,500 tokens**. Phase B saving overstated 4–6×. | Re-estimated Phase B saving down to **$0.01–$0.03/session** (was $0.04–$0.08). Phase B still net-positive but small. Combined estimate down to **$0.05–$0.18/session**, mid-range $0.08–$0.12. |
| IMPORTANT 1 | Tool-result content from `lookup_inspection_item` lands in cached prefix on subsequent turns → accumulating cost erodes Phase B saving. | New §3.4.1 — elide tool_result content to `<tool_result truncated id=X>` once the lookup-emitting Sonnet turn is complete. Net Phase B saving curve modelled honestly in §5. |
| IMPORTANT 2 | Trigger lexicon has no canonical home; iOS and backend will drift. | New §A.0.1 — canonical lexicon at `packages/shared-types/src/observation-triggers.ts`. Backend imports it. iOS embeds build-time copy with CI parity check (same shape as `field_schema.json` audit). Policy: lexicon additions ship in lockstep with iOS build, never backend-only. |
| IMPORTANT 3 | "30–50% regex-clean" estimate has no CloudWatch baseline. | Phase A now starts with **passive telemetry** (Day 1 morning): compute `shouldBypassSonnet` on every forwarded transcript but DO NOT skip. Log verdict + reason. After one field day, decide actual bypass rate before flipping the behaviour. |
| IMPORTANT 4 | Silent bypass for non-fast-path-eligible regex hits is a UX regression. | Phase A bypass gated on **regex-fast-TTS eligibility** (intersect with `regex-fast-eligibility.js`). If the fast-path ACK won't fire, don't bypass. Narrows bypass population but preserves the audible "got it" UX. Documented in §2.1. |
| IMPORTANT 5 | Phase B rollback story incomplete; `EICR_AGENTIC_SYSTEM_PROMPT` is module-init constant, env-flip wouldn't reach it without redeploy. | §3.5 rewritten — system prompt builder becomes lazy/per-session (mirror `_resolveSnapshotFormat` pattern). Tool schema conditionally includes `lookup_inspection_item` per session. Both env vars resolved at session construction. Rollback is a task-def update + service redeploy, NOT a runtime flip — documented honestly. |
| IMPORTANT 6 | Bypass eligibility ignores chitchat-pause state. | §2.1 check #8 added: bypass runs AFTER `sonnet-stream.js:973–1029` chitchat-wake branch so the wake side-effect still fires, only the downstream Sonnet call is skipped. |
| MINOR 1 | Phase C false-positive criteria contradict acceptance criteria. | §4.4 + §6.2 reconciled — false positives are explicitly acceptable; no upper bound. Brief mention in §4.4 that an inspector hearing "Noting that…" with no follow-up is mildly weird but harmless. Abort criterion removed. |
| MINOR 2 | Phase C row in saving table includes $0 line item that distorts the sum. | §0.2 table now omits Phase C; Phase C value in prose only. |
| MINOR 3 | Telemetry name `voice_latency.sonnet_bypass` doesn't match existing `voice_latency.gate_blocked` namespace. | Renamed to `voice_latency.bypass.applied` / `voice_latency.bypass.rejected_<reason>`. Field names mirror `gate_blocked` (`reason`, `had_pending_ask`, etc). |

---

## 1. Updated cost model (replaces v1 §5)

Honest mid-range estimates after corrections:

| Component | Phase 1 today | After Phase A | After Phase A+B |
|---|---|---|---|
| Sonnet turns/session | 24 | 16–20 (saving 4–8 turns) | 16–20 |
| Avg tokens read/Sonnet turn | 35,000 | 35,000 | **32,500** (SoI ≈ 2.5k removed) |
| Cache read $/turn | $0.0105 | $0.0105 | $0.0098 |
| Sonnet total $/session | ~$0.44 | ~$0.32–0.38 | ~$0.30–0.36 |
| Saving vs Phase 1 floor | — | **−14% to −27%** | **−18% to −32%** |
| $ saved | — | **$0.06–0.12** | **$0.08–0.14** |

(SoI tool-result accumulation modelled by truncating after one round-trip — see §3.4.1.)

**Total combined saving range: $0.05–$0.18/session (mid-range $0.08–$0.12).**

This is **smaller than v1 claimed** ($0.12–$0.30) but still real. At ~6 sessions/day current usage: ~£0.40–£0.50/day. At commercial launch scale: scales linearly. Phase A still does the bulk of the work; Phase B's contribution is modest but cheap to ship.

Phase A is **definitely worth shipping**. Phase B is **borderline** — only worth the effort if Phase A goes smoothly and the team has bandwidth. Phase C is UX and orthogonal.

---

## 2. Phase A — Skip Sonnet on regex-clean turns (v2 corrections)

### 2.0 Critical preconditions

**A.0 (NEW, mandatory before A.1):** server-side regex applier.

`src/extraction/eicr-extraction-session.js` gains a new method:

```js
applyRegexHitsToSnapshot(regexResults) {
  // Mirror _mergeIncomingJobStateIntoSnapshot precedence:
  //   - FACT_FIELDS  → iOS overwrites (no-op here; regex never writes facts)
  //   - READINGS     → iOS fills empty cells only; Sonnet-canonical wins
  // regexResults shape: [{ field: 'zs', value: 0.35, circuit: 3 }, ...]
  for (const r of regexResults || []) {
    if (!r || !r.field) continue;
    const isFact = FACT_FIELDS.has(r.field);
    const circuit = r.circuit ?? 0;
    const bucket = this.stateSnapshot.circuits[circuit] || (this.stateSnapshot.circuits[circuit] = {});
    if (isFact) {
      // Regex doesn't classify facts today, but defensive: don't overwrite
      // an existing fact via the regex channel.
      if (bucket[r.field] == null) bucket[r.field] = r.value;
    } else {
      // Reading — fill empty only (Sonnet-canonical wins).
      if (bucket[r.field] == null || bucket[r.field] === '') {
        bucket[r.field] = r.value;
      }
    }
  }
}
```

Called from the bypass path before the synthetic `conversationHistory` entry is appended.

**A.0.1 (NEW):** canonical observation-trigger lexicon at `packages/shared-types/src/observation-triggers.ts`:

```ts
export const OBSERVATION_TRIGGER_WORDS = Object.freeze([
  'observation', 'observations', 'noting', 'note that',
  'code 1', 'code 2', 'code 3', 'code one', 'code two', 'code three',
  'c1', 'c2', 'c3',
  'concern', 'danger', 'dangerous', 'hazard', 'unsafe',
  'broken', 'damage', 'damaged', 'missing', 'exposed',
  'loose', 'faulty', 'defective', 'cracked', 'burnt',
  'scorched', 'melted', 'corroded',
]);
```

Backend imports it. iOS bundles a build-time copy with a CI parity check at `scripts/check-observation-trigger-parity.mjs` (mirror of the field_schema audit). Policy: lexicon additions ship in lockstep with iOS — never backend-only.

### 2.1 Updated eligibility rules

Skip Sonnet for an utterance iff ALL hold:

1. At least one regex hit AND **regex-fast-TTS eligible** (intersect `regex-fast-eligibility.js`'s whitelist — preserves audible ACK; IMPORTANT 4).
2. No observation trigger from the canonical lexicon (§2.0).
3. No correction lead-in.
4. No question lead-in.
5. No pending `ask_user` in flight.
6. iOS did NOT tag as `in_response_to`.
7. No `start_dialogue_script` pattern.
8. **Chitchat-wake side-effect has already fired** if applicable (IMPORTANT 6). Bypass branches AFTER `sonnet-stream.js:973–1029`.

Failing ANY → forward to Sonnet as today. Conservative-by-design.

### 2.5 Updated implementation — bypass path

Pipeline order:

```
sonnet-stream.handleTranscript
  └─> existing chitchat-wake check (unchanged)
  └─> shouldForwardToSonnet (pre-LLM gate, unchanged)
  └─> NEW: shouldBypassSonnet — passive telemetry only until §2.7 Day-2 flip
        ├─ bypass: false → forward to existing extractFromUtterance path
        └─ bypass: true:
              1. session.applyRegexHitsToSnapshot(regexResults)  // BLOCKER 1 fix
              2. session.appendSyntheticBypassExchange(transcriptText, regexResults)  // BLOCKER 2 fix
              3. log voice_latency.bypass.applied
              4. ack to iOS (no TTS server-side — regex-fast-TTS handles audible)
              5. return — never enter extractFromUtterance, never enter buffer  // BLOCKER 3 fix
```

`appendSyntheticBypassExchange` appends:

```js
{role: 'user', content: [{type: 'text', text: '[BYPASSED REGEX-CLEAN] ' + transcriptText}]}
{role: 'assistant', content: [{type: 'tool_use', id: 'bypass-' + uuid, name: 'record_reading', input: {field: r.field, value: r.value, circuit: r.circuit}}]}
{role: 'user', content: [{type: 'tool_result', tool_use_id: 'bypass-' + uuid, content: 'recorded'}]}
```

One pseudo-`tool_use` block per regex hit (so Sonnet sees the writes as if they happened in a real turn). The `bypass-` ID prefix is the diagnostic marker for `reviewForOrphanedValues` (and CloudWatch grep).

### 2.7 Updated rollout

Day 1 morning: implement `applyRegexHitsToSnapshot`, `appendSyntheticBypassExchange`, `shouldBypassSonnet`, env-var `REGEX_BYPASS_MODE` (`off | shadow | live` mirror `SONNET_TOOL_CALLS` shape; default `off`).

Day 1 PM: deploy `REGEX_BYPASS_MODE=shadow` — runs eligibility check, logs verdict, but DOES NOT skip Sonnet. Passive telemetry only (IMPORTANT 3). Lets us pull the real bypass-rate baseline from CloudWatch.

Day 2 AM: read out 24h of shadow telemetry. Decide:
- If shadow bypass rate < 10% → abort Phase A (saving floor too small to justify ship; IMPORTANT 3 abort threshold).
- If shadow bypass rate ≥ 10% → flip `REGEX_BYPASS_MODE=live` on a canary task.

Day 2 PM: canary, two iPad sessions same scaffold as snapshot canaries. Read out:
- bypass_rate ≥ shadow-day baseline
- Sonnet turn count down proportionally
- Observation extraction count unchanged vs Phase 1 baseline
- No spike in `ask_user.missing_context`
- No regression in `reviewForOrphanedValues` finds (count + content)
- Per-session $ vs Phase 1 baseline session(s)

Day 3 AM: if canary green, fleet flip via task-def commit. If red, revert + investigate.

---

## 3. Phase B — SoI as lookup tool (v2 corrections)

### 3.1 Updated SoI footprint

Re-measured. `wc -c` against `config/prompts/schedule-of-inspection-bs7671-eicr.md`: **9,980 bytes** ≈ **2,500 tokens** (BLOCKER 4 confirmed). The "10–15k" claim in v1 was wrong by ~4–6×.

At 35k cache-read tokens/turn the SoI accounts for ~7% of cache reads, not 30%. Moving it behind a tool saves ~$0.0007/turn × Sonnet turns/session.

For a 16-turn Sonnet session: ~$0.012/session (gross). Minus the tool-result accumulation cost (see §3.4.1): **net ~$0.008–$0.020/session**. Honest range.

### 3.4.1 (NEW) Tool-result elision

After Sonnet processes a `tool_result` from `lookup_inspection_item` AND moves past that turn (i.e. the lookup-emitting Sonnet round has finished and committed its observation), the dispatcher **rewrites** that tool_result in `conversationHistory` to a stub:

```
{type: 'tool_result', tool_use_id: 'lookup-X', content: '<truncated>'}
```

Sonnet's observation has already been written; the verbatim SoI text isn't needed in the cached prefix going forward. This prevents the per-session accumulation effect IMPORTANT 1 identified.

Risk: Sonnet re-references the lookup mid-session and now sees `<truncated>`. Mitigation: Sonnet calls the tool again if it needs the text; cost is one additional ~300-token round-trip vs paying for the result in the cached prefix on every remaining turn.

### 3.5 Updated rollback story

`EICR_AGENTIC_SYSTEM_PROMPT` becomes lazy:

```js
// In EICRExtractionSession constructor (mirroring _resolveSnapshotFormat):
this.soiToolEnabled = this._resolveSoiToolEnabled(options.soiToolEnabled);
this.systemPrompt = this._buildSystemPrompt();

_buildSystemPrompt() {
  const base = _AGENTIC_BASE_PROMPT;
  if (this.soiToolEnabled) {
    return base + '\n\n' + _SCHEDULE_OF_INSPECTION_DIRECTORY;  // compact
  }
  return base + '\n\n' + _SCHEDULE_OF_INSPECTION_EICR;  // full SoI
}
```

Tool schema conditionally includes `lookup_inspection_item`:

```js
buildToolSchemas() {
  const tools = [...BASE_TOOLS];
  if (this.soiToolEnabled) tools.push(LOOKUP_INSPECTION_ITEM_TOOL);
  return tools;
}
```

Both env vars resolved at session construction (Pitfall 4: do not read env at runtime).

Rollback = task-def env-var change → ECS service redeploy. **NOT a runtime flip.** Documented explicitly.

Abort criterion (NEW): if a session with `SOI_TOOL_ENABLED=false` logs a `lookup_inspection_item` tool call, P0 abort.

### 3.6 Updated risks

| Risk | Mitigation |
|---|---|
| Observation extraction quality regression | Directory drafted by hand-walking 20 common BS 7671 observations + verifying Sonnet picks the right item from just the directory line. Pre-canary E2E test: 5 prerecorded observation-heavy transcripts diffed against baseline. |
| `lookup_inspection_item` fires every turn | Canary metric: tool_call_rate vs observation_count. Must be ≤ 1.5× (some retries acceptable). |
| Tool-result accumulation erodes saving | §3.4.1 truncation. Canary metric: cache_read tokens/turn vs Phase 1 baseline. |
| Lazy prompt build performance | Constructor work is one string concat per session — negligible. |

---

## 4. Phase C — TTS bridge (v2 corrections)

### 4.4 Reconciled acceptance criteria

False positives **are acceptable, no upper bound**. The bridge is cheap (bundled audio, no API call) and the worst case is an inspector hearing "Noting that…" with no follow-up observation — mildly weird, harmless, no regression vs today's silence-while-Sonnet-thinks.

Abort criteria removed. Phase C ships when the iOS-side detector + bundled asset are in place and the integration test confirms the bridge plays without colliding with subsequent server TTS.

---

## 5. Out-of-scope (unchanged from v1, restated)

- Phase 4 ops ledger (still gated).
- Haiku tiering.
- Compressing per-turn user message phrasing.

---

## 6. Sequencing (replaces v1 §6)

| Day | Phase | Activity |
|---|---|---|
| 1 AM | A.0 + A.0.1 | Server regex applier, synthetic exchange helper, canonical lexicon, env-var resolver. Tests. |
| 1 PM | A | Deploy `REGEX_BYPASS_MODE=shadow` — passive telemetry. |
| 2 AM | A | Read out 24h shadow telemetry. Decide: ship vs abort. |
| 2 PM | A | If ship: canary `REGEX_BYPASS_MODE=live` on one task. Two iPad sessions. |
| 3 AM | A | Read out canary. Fleet flip if green. Phase B implementation starts in parallel. |
| 3 | B | Compact directory drafted by hand. Lazy prompt build path. Tool schema. Dispatcher. Tool-result elision. Tests. |
| 3 PM | B | Deploy `SOI_TOOL_ENABLED=false` default (full SoI in prompt unchanged). Code lands inert. |
| 4 AM | B + C | iOS TestFlight build with C's trigger detector + bundled audio. Backend canary `SOI_TOOL_ENABLED=true`. |
| 4 PM | B + C | iPad field test. Read out. |
| 5 | B + C | Fleet flip if green; otherwise iterate. |

Calendar slip-tolerance: each phase has independent canary + flag. If A's shadow telemetry says < 10% bypass rate, abort A early and proceed to B alone. If B's directory walk-through finds observation quality unsalvageable, abort B and ship A alone. C is independent of A and B's outcomes — TestFlight cycle can run in parallel either way.

---

## 7. Reviewer audit trail

- [x] PLAN.md (v1) — Claude self-review v1: 4 BLOCKERs, 6 IMPORTANTs, 3 MINORs (claude-review-v1.md). Folded into this v2.
- [ ] PLAN_v2.md — Claude self-review v2 (in progress next).
- [ ] PLAN_v2.md — Codex CLI review.
- [ ] Iterate until both reviewers report zero BLOCKERs.

Verdict gate before commit / ship: zero BLOCKERs from both reviewers.
