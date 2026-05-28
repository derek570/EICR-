# Extraction-bypass sprint v7 — measured cost data + server-side walkthrough entry

**Date:** 2026-05-28
**Iteration:** v7 (folds measured bypass rates from 3 real production sessions + adds server-side walkthrough entry as Phase D)
**Sprint scope:** **4 phases**, ~6–8 days end-to-end
**Branches:** `regex-bypass-backend`, `regex-bypass-ios`, `soi-tool-lookup`, `observation-tts-bridge`, `walkthrough-server-entry`

v7 builds on PLAN_v6's review-converged design. Two changes:

1. **Cost model corrected against real session data** (PLAN_v6's $0.01–$0.03/session was 5–15× too pessimistic).
2. **New Phase D — server-side walkthrough entry triggered by iOS regex** — closes one of the biggest remaining bypass blockers identified in the measured data: walkthrough turns (ring continuity, IR, OCPD) where Sonnet's only job is to fire `start_dialogue_script`.

---

## 0. Measured data (3 production sessions)

| Session | Date | Turns | Total $ | Single-round early-terminated turns (proxy for bypass-eligible) | Bypass rate | $ saved if bypassed | % reduction |
|---|---|---|---|---|---|---|---|
| DFE90C4F | 2026-05-28 | 13 | $0.33 | 7 | **54%** | $0.13 | 39% |
| C61473FD | 2026-05-27 | 24 | $0.58 | 10 | **42%** | $0.18 | 31% |
| 33E6613D | 2026-05-26 | 76 | $2.66 | 15 | **20%** | $0.27 | 10% |
| **All 3** | | **113** | **$3.57** | **32** | **28% avg** | **$0.58** | **16%** |

The 86-turn session brings the average down because real EICRs include walkthroughs (ring continuity per socket, IR L-L and L-E for all circuits), bulk operations ("for all circuits"), and multi-circuit disambiguation — all of which today require Sonnet.

**Phase D (server-side walkthrough entry, NEW in v7) directly addresses the largest non-bypass-eligible category** — walkthrough turns. Modelled saving in §4 below.

## 0.1 Revised cost projection

| | v6 estimate | v7 measured | At launch scale (100 inspectors × 6/day) |
|---|---|---|---|
| Phase A only ($-saved/session) | $0.01–$0.03 | **$0.13–$0.27** | **£25k–£60k/year** |
| Phase A + D ($-saved/session) | — | **$0.20–$0.40** (estimated; D bypasses walkthrough-entry turns) | **£45k–£90k/year** |
| Combined A+B+C+D | $0.015–$0.035 | **$0.21–$0.42** | **£45k–£90k/year** |

At current 6-session/day usage: **£1.20–£2.50/day saved**, ~**£500/year**. Pays back the sprint cost in roughly 2–3 months at current scale, instantly at launch scale.

**Worth shipping.** Original v6 conclusion ("mechanism establishment, not $-saving") is wrong given the measured data.

---

## 1. Already-shipped infrastructure v7 doesn't have to build

Worth being explicit about what's already in production so v7's scope is tight:

| Capability | Where it lives | Used by | v7 changes? |
|---|---|---|---|
| **Server-side ElevenLabs TTS for regex-caught readings** | `src/routes/voice-latency-fast-tts.js` (POST `/api/voice-latency/regex-fast-tts`) | iOS posts a regex hit; server composes confirmation text via `buildConfirmationText`, generates audio via ElevenLabs, returns to iOS. **No Sonnet round needed for the TTS itself.** Live in prod for the 5 whitelisted fields. | No — Phase A consumes this. Bypass = skip Sonnet AND fire the existing fast-TTS in parallel. |
| **iOS designation→circuit-ref resolution** | `TranscriptFieldMatcher.swift:1184` (`designationMap`) + `:1420, :1468` (schedule lookup) | Inspector says "cooker" → iOS looks up the Cooker circuit's ref and writes `circuitUpdates[ref].measuredZsOhm`. | No — Phase A relies on this for the "Zs for cooker" case. |
| **Stage 6 live-mode no-history-replay** | `stage6-shadow-harness.js:373-379` (one-message window) | Confirmed by Codex v2 review: synthetic conversationHistory writes are unnecessary in live mode. | No — Phase A skips synthetic history writes accordingly. |
| **Pre-LLM transcript gate** | `src/extraction/pre-llm-gate.js` | Blocks filler ("yeah", "ok") before reaching Sonnet. Bypass is an additional layer downstream. | No — Phase A extends the gate, doesn't replace. |
| **Dialogue-script processors** (ring continuity, IR, OCPD) | `ring-continuity-script.js`, `insulation-resistance-script.js`, `protective-device-script.js`, dispatched from `sonnet-stream.js:3311-3408` | Once a script is active, subsequent utterances are intercepted server-side before Sonnet. | **YES — Phase D adds server-side ENTRY (today entry is Sonnet-driven via `start_dialogue_script` tool).** |
| **Stage 6 multi-board sprint** | shared-types boards, `record_board_reading`, etc. | Phase A.0d board-routing piggy-backs on this. | No — Phase A consumes. |

---

## 2. Phase A — Skip Sonnet on regex-clean turns (v7 — unchanged from v6)

Carried verbatim from PLAN_v6. Only change: §1 cost model now grounded in measured bypass rate (28% average, not 5-10%).

---

## 3. Phase B — SoI as lookup tool (v7 — unchanged from v6)

Carried.

---

## 4. Phase D (NEW) — Server-side walkthrough entry via regex

### 4.1 Problem

Today's walkthrough entry flow (e.g. ring continuity for socket 5):

1. Inspector says "ring continuity for the sockets" or "I'm doing the ring on circuit 5" or "lives 0.04 sockets" (one of many trigger phrases).
2. Transcript goes to Sonnet via the normal path.
3. Sonnet's `start_dialogue_script` tool description (`stage6-tool-schemas.js:774-829`) tells it to recognise the intent and call the tool.
4. Tool dispatch creates `session.ringContinuityScript = {...}` server-side.
5. Subsequent utterances ("lives 0.04", "neutrals 0.05", "earths 0.07") are intercepted by the ring-continuity script processor BEFORE Sonnet on the next turn — those subsequent turns are deterministic and bypass-able in principle, except they also need Sonnet to handle the script's exit when the inspector says something off-script.

**The entry turn (step 1–4) is pure Sonnet overhead.** Sonnet's only job is to recognise a pattern and call one tool. iOS regex already has the pattern recognition for ring continuity (`TranscriptFieldMatcher.swift:257`: `Pre-compiled regex for detecting ring continuity language in transcripts`).

Across the 3 measured sessions, walkthrough-entry-only turns accounted for ~5–10 turns of the 86-turn session, ~1 turn of the 24-turn, 0 of the 13-turn. Eliminating these turns alone could raise the bypass rate from 20% → 30% on long sessions.

### 4.2 Design

iOS regex detects a walkthrough trigger phrase. It includes a `dialogue_script_intent` field in the regex hits payload:

```json
{
  "type": "transcript",
  "text": "ring continuity for the sockets",
  "regexResults": [
    { "field": "measured_zs_ohm", "value": null, "circuit": 5, "_marker": "designation_resolved" }
  ],
  "dialogue_script_intent": {
    "type": "ring_continuity",
    "circuit": 5,
    "pending_writes": {}
  }
}
```

Or for IR with a value in the same utterance ("insulation resistance live to live greater than 299 on cooker"):

```json
{
  "dialogue_script_intent": {
    "type": "insulation_resistance",
    "circuit": <ref of Cooker>,
    "pending_writes": { "ir_live_live_mohm": ">299" }
  }
}
```

Server handler in `sonnet-stream.handleTranscript`:

```js
// NEW — line ~3260, after originalTranscriptText capture but BEFORE script processors
if (msg.dialogue_script_intent && SERVER_WALKTHROUGH_ENTRY_ENABLED) {
  const intent = msg.dialogue_script_intent;
  const initOk = tryServerInitScript(entry.session, intent);
  if (initOk) {
    // Script entered without Sonnet. Subsequent utterances flow through the
    // existing script processors at lines 3311-3408 as today.
    // If any pending_writes were attached, apply them via the existing
    // script's write-value path.
    logger.info('voice_latency.walkthrough_server_entry', {
      sessionId,
      script_type: intent.type,
      circuit: intent.circuit,
      pending_writes: Object.keys(intent.pending_writes ?? {}),
    });
    // Stamp dedupe ledger same as bypass.
    stampSeenTranscript();
    return;
  }
  // Server-init failed (e.g. ambiguous designation, script already active
  // for a different type). Fall through to Sonnet — same logic Sonnet
  // would have applied anyway.
}
```

`tryServerInitScript` mirrors the existing `start_dialogue_script` dispatcher logic, lifted out of Sonnet's tool-call path so both surfaces share the same script-init code.

### 4.3 Eligibility for server-side init

Skip server-side entry, defer to Sonnet, if ANY of:

- iOS regex isn't confident about the script type (returns `dialogue_script_intent.type === 'ambiguous'` or omits intent).
- The circuit ref couldn't be resolved (designation matched 2+ circuits in the schedule).
- A different script is already active on the session (e.g. inspector says "ring" while IR is mid-walkthrough — Sonnet handles the transition).
- The trigger phrase is ALSO a valid one-shot reading (e.g. "Circuit 4 BS-EN 60898" — Sonnet decides whether that's an OCPD entry or a one-shot `record_reading`, per the existing tool description).

### 4.4 iOS detection patterns

iOS already has ring continuity language regex. v7 adds equivalent regexes for IR and OCPD entry:

- **Ring continuity:** `"ring (cont(inuity)?|main|final).*\\b(for|on)\\b.*<designation|ref>"` OR `"(lives|neutrals|earths) (are )?\\d"` (the bare-values form).
- **Insulation resistance:** `"(insulation|installation|international) resistance"` + optional value forms.
- **OCPD:** `"(doing|set(ting)?) (the )?(ocpd|bs.?en|breaker|protection)"` — uses the "explicit walkthrough" phrasing the tool description already documents (NOT one-shot like "Circuit 4 BS-EN 60898").

Each pattern returns `dialogue_script_intent.type` + extracted partial slots.

### 4.5 Cost model

For the 86-turn session, server-side walkthrough entry would have:
- Saved ~5 walkthrough-entry turns (an estimate; the session had 1 ring + 2 IR walkthroughs + 2 OCPD entries roughly)
- At $0.018/turn = $0.09 additional saved
- Total session saving Phase A + Phase D: **~$0.36 per 86-turn session** (vs Phase A alone: $0.27)

For shorter sessions, marginal impact is smaller — but the shorter sessions already had high bypass rates without walkthroughs.

### 4.6 Risks

| Risk | Mitigation |
|---|---|
| iOS regex mis-classifies "Circuit 4 BS-EN 60898" as OCPD entry instead of one-shot reading | Eligibility check #4 — iOS detects the "one complete value" form and emits no intent. Mirror the prose contract in `start_dialogue_script` tool description. |
| Server-init script silently differs from Sonnet-init script | Single source of init code — factor out of the existing dispatcher and call from both paths. |
| Inspector says ring trigger mid-IR walkthrough | Eligibility #3: defer to Sonnet when another script is active. Sonnet handles transitions. |
| Garbled trigger words (Deepgram "instellation" → "installation") | iOS regex already tolerates IR garbles (per `:257` comment block). Phase D extends with explicit garble whitelist. |

### 4.7 Rollout

- Day 4 (after Phase A canary green): iOS PR adds the three new trigger regexes + `dialogue_script_intent` wire field. Internal TestFlight.
- Day 5 AM: backend PR adds `tryServerInitScript` + handler integration + `SERVER_WALKTHROUGH_ENTRY=shadow` mode (passive telemetry).
- Day 5 PM: read out shadow telemetry, decide ship vs abort.
- Day 6: canary `SERVER_WALKTHROUGH_ENTRY=live`. iPad session with deliberate ring + IR + OCPD walkthrough patterns.
- Day 6 PM: fleet flip if green.

---

## 5. Phase C — TTS bridge (v7 — unchanged from v6)

Carried.

---

## 6. Sequencing (replaces v6 §5)

| Day | Branch | Activity |
|---|---|---|
| 0 | iOS `regex-bypass-ios` | Phase A wire-shape change. Internal TestFlight install. |
| 1 AM | backend `regex-bypass-backend` | Phase A server-side. `REGEX_BYPASS_MODE=shadow`. |
| 2 AM | — | Read shadow telemetry. Canary flip. |
| 2 PM | — | Phase A canary. iPad session. |
| 3 AM | — | Phase A fleet flip if green. |
| 3 PM | backend `soi-tool-lookup` | Phase B implementation. |
| 3 PM | iOS `observation-tts-bridge` | Phase C iOS work. |
| 4 AM | — | Phase B + C deploy + canary. |
| 4 PM | iOS `walkthrough-server-entry` | Phase D iOS — ring/IR/OCPD trigger regexes + wire field. |
| 5 AM | backend | Phase D server-side. `SERVER_WALKTHROUGH_ENTRY=shadow`. |
| 5 PM | — | Phase D shadow read-out + canary flip. |
| 6 AM | — | Phase D canary. iPad session with deliberate walkthroughs. |
| 6 PM | — | Phase D fleet flip if green. |
| 7 | — | Buffer / soak / iteration. |

---

## 7. Reviewer audit trail (v7)

- [x] PLAN.md (v1) → v6: 5 review iterations, ended at 0 BLOCKERs from both Claude self-review and Codex CLI.
- [x] PLAN_v7 — incorporates measured production data (3 sessions, 113 turns, real bypass-rate count) + Phase D (server-side walkthrough entry).
- [ ] PLAN_v7 — final Claude + Codex review pass (recommended given Phase D is new architectural surface).

Phase D introduces a new code surface (`tryServerInitScript`, iOS trigger regex extensions, `dialogue_script_intent` wire field) — worth one more review cycle to verify no integration issues. Phase A/B/C remain v6-reviewed-clean.
