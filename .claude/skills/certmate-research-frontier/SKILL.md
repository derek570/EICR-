---
name: certmate-research-frontier
description: >
  Load when the task is about CertMate's RESEARCH DIRECTION or EXTERNAL POSITIONING:
  "zero-touch certification", hands-free / eyes-free EICR ambition, what to build next
  beyond parity, why CertMate beats or doesn't beat iCertifi (Board Vision / Test Vision /
  Spark AI / Certificate Guardian), what is novel vs known, what claims are safe to make
  in marketing/forum posts/investor material, what evidence a claim needs, or designing a
  falsifiable milestone for a new capability. Also load when a plan proposes a NEW voice
  capability and you must check it against the frontier gap map and claims discipline.
  Do NOT load for executing the existing latency campaign (certmate-latency-campaign),
  day-to-day debugging (certmate-debugging-playbook), or wire-protocol details
  (certmate-voice-wire-protocol).
---

# CertMate Research Frontier — Zero-Touch Certification

The confirmed north-star (Derek, 2026-07): **ZERO-TOUCH CERTIFICATION** — an inspector
completes a full EICR (Electrical Installation Condition Report, the UK periodic
inspection certificate under BS 7671) wearing AirPods, phone pocketed, **no screen
interaction from arrival to finished certificate**. The spoken channel is the primary UI;
the screen is a mirror. This skill maps what stands between today's product and that
end-state, what competitors have, which claims are earned vs unearned, and the first
concrete steps IN THIS REPO for each frontier problem.

Everything here routes through change control. Nothing in this skill authorises touching
`src/`, `config/prompts/`, or `packages/shared-*` during PWA-only work — see
`certmate-change-control` and the MANDATORY blocks in `/CLAUDE.md`. A frontier idea that
needs a backend change needs an explicit cross-platform mandate first.

## When NOT to use this skill

| If the task is… | Use instead |
|---|---|
| Executing the dictate→confirm latency campaign (bench commands, gates, solution menu) | `certmate-latency-campaign` |
| Measuring latency/cost/accuracy with the existing toolkit | `certmate-proof-and-analysis-toolkit`, `certmate-diagnostics-and-tooling` |
| The evidence bar / hypothesis lifecycle for accepting a result internally | `certmate-research-methodology` |
| WebSocket frame shapes for `/api/sonnet-stream` | `certmate-voice-wire-protocol` |
| BS 7671 domain terms (Ze/Zs, C1/C2/C3/FI, LIM, 29 circuit columns) | `bs7671-domain-reference` |
| CCU photo pipeline internals | `certmate-ccu-pipeline` |
| Deciding whether a change is even allowed (backend-immutable, web-companion) | `certmate-change-control` |
| Debugging a live failure | `certmate-debugging-playbook` |

## 1. Definitions (once)

- **Zero-touch session**: a recording session in which every certificate-relevant action
  (readings, corrections, observations, board switches, clarification answers) happens by
  voice, and every applied value is heard back — zero taps between "start" and "review".
- **Audio-First invariants**: three MANDATORY product laws in `/CLAUDE.md`
  ("Audio-First Design Principles"): (1) every dictated reading is read back aloud exactly
  once, never silently entered (auto-derivations exempt by design); (2) structurally
  complete readings are WRITTEN regardless of self-reported model confidence and read
  back — never silently dropped; (3) latency is a first-class concern.
- **Stage 6**: the server-side agentic extraction loop (`src/extraction/`) — a live LLM
  (Haiku 4.5 as of 2026-07-06, `SONNET_EXTRACT_MODEL` in `ecs/task-def-backend.json`)
  calling schema-generated tools over the `/api/sonnet-stream` WebSocket.
- **Flux / EoT**: Deepgram's `flux-general-en` speech model on `/v2/listen` with built-in
  end-of-turn (EoT) detection — conversational turn-taking, not just transcription.
- **LIM**: "limitation" — a first-class insulation-resistance sentinel value meaning
  "test not performed due to a limitation". Parsed in
  `src/extraction/dialogue-engine/parsers/megaohms.js`.
- **Field session**: a real on-site job run by Derek; identified by session ID; its debug
  log is the evidence unit (§5).

## 2. Competitive landscape — why current SOTA falls short

### iCertifi (the direct contest — verified live 2026-07-06 at icertifi.co.uk)

iCertifi (established UK cert app, App Store since 2012) shipped four AI features in its
12.12.30 release cycle (marketed from early 2026; exact launch date UNVERIFIED beyond
"live as of 2026-07"): **Board Vision** (distribution-board photo scan; marketing claims
"95%+ accuracy", ~3p/circuit token pricing), **Board Vision 2.0**, **Test Vision**
(capture test data from instrument screens), **Spark AI** (BS 7671-trained Q&A chatbot),
**Certificate Guardian** (pre-send automated compliance check).
Re-verify: https://icertifi.co.uk/ai-electrical-certification/ and
https://icertifi.co.uk/board-vision/.

**Structural read** (analysis, not verified fact): all four are **screen-mediated point
tools** — photograph, tap, review a form, type a question. None of them is a hands-free
conversational loop; none claims spoken read-back of applied values, live multi-turn
extraction during the walk, or turn-taking dialogue. iCertifi CONTESTS the "AI board
scan" and "AI assistant" story; it does NOT currently contest the eyes-free axis.

| Differentiator | Status vs iCertifi (2026-07-06) |
|---|---|
| CCU photo → circuits | **CONTESTED** (Board Vision). CertMate's edge is integration into a live voice session + blank-beats-guessed-wrong doctrine, not the scan per se. Do not lead marketing with it. |
| BS 7671 Q&A | **CONTESTED** (Spark AI). CertMate's observation-code lookup is embedded in dictation flow, not a chatbot — different claim, but "AI knows the regs" is no longer novel. |
| Pre-issue compliance check | **CONTESTED** (Certificate Guardian). CertMate has no equivalent named feature — open/candidate. |
| Live voice dictation → structured certificate, spoken read-back, hands-free correction | **UNCONTESTED axis** as of 2026-07-06. This is the frontier — and the only claim territory where being first matters. Re-verify before any public claim (competitors ship fast). |

### Why generic SOTA (dictation apps, LLM wrappers) fails at zero-touch

1. **Silent misfiles are safety-critical.** A mis-filed reading on an EICR is a legal
   document defect. Generic ASR+LLM pipelines silently drop or misroute low-confidence
   input; CertMate's answer is invariant #2 (write + read back, correct by voice) — the
   inspector's ear is the verifier. No off-the-shelf stack has this contract.
2. **Domain garble.** Deepgram renders "LIM" as lion/limb/Lynn, "trip time" as
   "tryptoid". Generic systems either pass garbage through or "correct" it with fuzzy
   matching — which this project BANNED for free text (recorded in-repo in the
   2026-07-03 changelog row; original decision 2026-06-24 per project memory,
   unverified in-repo — see certmate-failure-archaeology. A false
   correction on a safety certificate is worse than a miss). The sanctioned tools are
   curated equal-weight Deepgram keyterms and tightly-bounded closed-enum matching (e.g.
   the Levenshtein-distance-1, unique-match-only BS-code parser,
   `src/extraction/dialogue-engine/parsers/bs-code.js`) — see `certmate-research-methodology`.
3. **Turn-taking.** A read-back loop needs to know when the speaker finished. Push-to-talk
   is a screen touch; naive VAD barges in. Flux EoT + the TranscriptGate/chime pattern is
   the working answer.
4. **Latency.** Conversational read-back above ~2s feels broken. Generic pipelines don't
   optimise the full chain (STT EoT → LLM TTFT → confirmation synthesis → TTS TTFB →
   playback). CertMate measures each hop (`scripts/voice-latency-bench/`).

## 3. CertMate's asset inventory (each verified in-repo 2026-07-06)

| Asset | Where | Why it matters for zero-touch |
|---|---|---|
| Audio-First invariants as MANDATORY law | `/CLAUDE.md` "Audio-First Design Principles" | The zero-touch contract is already product law, not aspiration — every PR is reviewable against it. |
| Flux EoT on BOTH platforms | iOS `CertMateUnified/Sources/Services/DeepgramService.swift`; web `web/src/lib/recording/deepgram-service.ts` (`buildFluxURL`, flipped to flux in prod 2026-07-03 — `ecs/task-def-frontend.json` `DEEPGRAM_STT_MODEL=flux`, runtime-reversible in ~3-5 min) | Turn detection without touching the screen, with an operable kill-switch for A/B (see `certmate-config-and-flags`). |
| Server-side agentic loop, 16 tools | `src/extraction/stage6-tool-schemas.js`: record_reading, clear_reading, create_circuit, rename_circuit, record_observation, delete_observation, ask_user, record_board_reading, delete_circuit, calculate_zs, calculate_r1_plus_r2, start_dialogue_script, set_field_for_all_circuits, mark_distribution_circuit, select_board, add_board | The voice-reachable action surface. Tool enums are generated from `config/field_schema.json` at module load — extending voice coverage = extending schema+tool+dispatcher, not rearchitecting. |
| Read-back pipeline with FIFO + cancel | backend `confirmations[]` on `extraction` frames; web `web/src/lib/recording/tts-queue.ts` (shipped 2026-07-06, PR #85); `cancel_pending_tts` emitted at `src/extraction/dialogue-engine/engine.js:1021` | Exactly-once spoken confirmation is implemented and tested on web + iOS — the invariant has machinery, not just words. |
| Domain parsers | `src/extraction/dialogue-engine/parsers/megaohms.js` (LIM sentinel, ">200" high-value), `parsers/bs-code.js` (bounded Lev-1) | Spoken electrical values parse deterministically before any LLM sees them. |
| Field-session telemetry | Client debug logs uploaded to `s3://<bucket>/session-analytics/{userId}/{sessionId}/debug_log.jsonl` (upload site `src/routes/recording.js:1436`); analysed by `node scripts/analyze-session.js <dir>` (needs `debug_log.jsonl` + `field_sources.json` + `manifest.json`; emits `analysis.json`) | Every field session is a replayable experiment. This is the evidence unit for all claims (§5). |
| Latency bench harness | `scripts/voice-latency-bench/` — `npm run voice-test` (transcript-replay.mjs, YAML scenarios in `tests/fixtures/voice-latency-scenarios/`), `npm run voice-regression`, `sonnet-ttft-bench.mjs`, `elevenlabs-ttfb-bench.mjs` | Per-hop latency decomposition without a field visit. |
| CCU vision pipeline | `src/extraction/ccu-single-shot.js` (single-shot gpt-5.5, live) | Board context pre-loaded before dictation starts — the voice session begins with circuits already named. |
| Parity-governed dual client | `web/docs/parity-ledger.md` (396 rows, id + last-verified columns), CI warn `scripts/check-parity-ledger.mjs` | A zero-touch capability shipped on one platform has a governed path to the other — no dual-frontend drift relapse. |
| Ambient session management | 2-tier Deepgram auto-sleep (active/sleeping — dozing tier dropped 2026-04-27; ADR-007's 3-tier description is historical, see certmate-architecture-contract §8; web `web/src/lib/recording/sleep-manager.ts`) + chitchat pause (backend stops forwarding after zero-engagement turns, wake triggers) | Long pocketed sessions without cost blowout or accidental extraction of chitchat. |

## 4. Frontier problems

Each entry: why SOTA fails → CertMate's lever → first three concrete steps IN THIS REPO →
falsifiable milestone. All milestones are judged on field-session evidence (§5), never by
eye/ear impression.

### F1 — Close the zero-touch gap map (the master problem)

**Today's mandatory screen touches in a field session** (gap map, verified 2026-07-06):

| Touch | Voice-reachable today? | Notes |
|---|---|---|
| Open job + start recording | NO | App navigation + record button. |
| CCU photo capture | NO (inherently camera) | Framing needs eyes; capture/confirm could be voice-triggered. |
| Board/circuit readings, corrections, board switch | **YES** | record_reading / record_board_reading / select_board / dialogue scripts. |
| Observations (text + code) | **YES** (record_observation, C1/C2/C3/FI auto-coding) | Observation PHOTOS still touch. |
| Clarification answers (ask_user) | **YES** | Voice-answered, tool_call_id-keyed. |
| Inspection schedule (~90 EICR + ~14 EIC items) | **NO** | See F3 — largest structural gap. |
| Attestations/signatures (7 on web since WS7) | NO (drawn signatures) | Legally sensitive; candidate: pre-registered signature applied after spoken attestation. UNVERIFIED whether UK scheme providers (NICEIC/NAPIT) accept that — check before building. |
| PDF generation + review | NO | Generation is a button; review is inherently visual today. Candidate: spoken certificate summary as audit substitute. |

**First three steps in this repo:**
1. Instrument the gap: add a screen-touch counter to a field-session analysis — extend
   `scripts/analyze-session.js` (or a sibling script in `scripts/`) to classify each
   certificate-field write in `field_sources.json` by origin (voice vs manual UI edit) and
   report `manual_touch_count` per session. Zero code outside `scripts/` = no change-control friction.
2. Publish the gap map as a tracked table (this section) and re-verify per release; record
   candidate items in the gap-map table here and hand them to the user's normal planning
   flow (`/rp`).
3. Pick the highest-frequency remaining touch from real sessions (measured in step 1, not
   guessed) as the next `/rp` plan target.

**Milestone (falsifiable):** one complete real EICR field session, N ≥ 10 circuits, where
`analysis.json` shows every circuit/board/observation value voice-originated, spoken-
confirmation count == applied-reading count (exactly-once), and manual touches limited to:
open app, start, CCU photo, signatures, generate. Then shrink that allowed-touch list
release by release. You have THE result when the allowed list is empty except camera
framing and the session still yields a valid certificate.

### F2 — Conversational latency (dictate→confirm ≤ human-assistant feel)

Why SOTA fails: nobody publishes an end-to-end budget for STT-EoT→LLM→TTS read-back in a
noisy plant room; generic stacks stall on LLM TTFT. CertMate's lever: the per-hop bench
suite + prod telemetry + a ranked solution menu (FINALIZER_TIMEOUT_MS at
`src/extraction/voice-latency-turn-summary.js:119`, currently 8000ms; fast-path TTS;
speculator). **Execution lives in `certmate-latency-campaign` — do not duplicate it here.**
Open items feeding it (as of 2026-07-06): WS3b item 4 — web does not consume the regex
fast-path TTS route (`src/routes/voice-latency-fast-tts.js` exists; web advertises only
`low_conf_readback_v1` in `web/src/lib/recording/sonnet-session.ts:586`, iOS additionally
advertises `regex_fast_v2`); item 5 — playback telemetry absent.
**Milestone:** a field session whose debug log shows p50 dictate-end→playback-start under
an agreed target (set the number in the latency campaign, not here) with zero invariant-#1
violations. A bench number alone is NOT the result.

### F3 — Voice-complete inspection schedule (largest tool-surface gap)

The EICR schedule of inspection (~90 items, outcomes tick/N/A/C1/C2/C3/LIM) and EIC
(~14 items) are **not voice-reachable**: `inspection_schedule_fields` exists in
`config/field_schema.json` but is excluded from both the `record_reading` and
`record_board_reading` enums (`src/extraction/stage6-tool-schemas.js:76-92` builds from
circuit/board/supply/installation groups only — verified 2026-07-06). An inspector cannot
complete an EICR hands-free while ~90 items require tapping.
Why SOTA fails: a 90-item checklist read aloud item-by-item is unusable; the research
problem is *spoken bulk assertion* ("section 5 all satisfactory except 5.12, C2, thermal
damage to busbar") mapped to itemised outcomes with exactly-once read-back of only the
exceptions — a batching/summarisation dialogue problem no cert app has attempted.
**Steps:** (1) design the wire + tool contract first as an `/rp` plan — this is a BACKEND
change (tool schema + dispatcher + prompt) and therefore needs an explicit cross-platform
mandate + web companion under change control; do NOT start in code. (2) Prototype the
utterance→outcome mapping OFFLINE against transcripts from past sessions (fixtures under
`tests/fixtures/`) to measure ambiguity rate before touching the live loop. (3) Ship
behind a capability flag mirroring the `low_conf_readback_v1` pattern.
**Milestone:** a field session completing a full EICR inspection schedule by voice with
exceptions-only read-back, and the resulting PDF schedule identical to what the inspector
asserts on later visual review (zero misfiled outcomes). Status: **open/candidate — no
plan exists yet.**

### F4 — Provable exactly-once read-back (trust without eyes)

Why SOTA fails: hands-free systems are trusted only if silent drops are provably ~zero;
nobody instruments this. CertMate already treats a dropped confirmation as a P1 (the
2026-07-06 TTS FIFO shipped precisely because a two-circuit turn read back only the last
circuit). Lever: the confirmation pipeline is now centralised (FIFO + dedupe key +
`cancel_pending_tts`), so the invariant is auditable from logs.
**Steps:** (1) define the audit predicate: per session, applied-readings set ≡
spoken-confirmations set (auto-derivations exempt) — computable from `debug_log.jsonl` +
`field_sources.json`; (2) implement it as an analyzer check in `scripts/` (script-only,
no product code); (3) run it retroactively over stored session-analytics dirs to get a
baseline silent-drop rate. **Milestone:** the predicate holds at 100% across ≥3
consecutive real field sessions on both platforms; any violation reproduces to a session
ID + timestamp. This audit is also the guard that F2 latency work never trades away
correctness. Status: predicate script **open/candidate**; machinery it audits is shipped.

### F5 — Domain-robust ASR without fuzzy correction

Why SOTA fails: vocabulary adaptation via free-text post-correction risks confident
misfiles (banned here). Lever: Flux equal-weight keyterms — mechanism VALIDATED for the
LIM garble by the WS4 synthetic TTS→Flux probe (2026-07-03; "lion"→"LIM" corrected), but
the probe was INCONCLUSIVE on insulation/trip-time (synthetic voice too clean), so the
curated iOS keyterm list is HELD pending a real-audio spot check (see changelog
2026-07-03 row in `docs/reference/changelog.md`).
**Steps:** (1) collect real-audio garble samples from field sessions (debug logs carry
transcripts; flag garbles in analysis); (2) rerun the WS4 probe method with real audio
instead of TTS; (3) ship the curated list as the ONE coordinated iOS+web wave the WS4
plan requires. Candidate (vault-tracked, not started): deterministic normaliser tweaks
("milligrams"→"MΩ" class) — these are closed-vocabulary rewrites, allowed; free-text
edit-distance correction is NOT. **Milestone:** measured garble-miss rate on the
known-garble utterance set drops with keyterms ON vs OFF in real audio, with zero
false-correction incidents across the validating field sessions.

### Explicitly fenced-off directions (do not "discover" these again)

| Dead end | Why fenced | Record |
|---|---|---|
| Amplitude-based TTS barge-in | Mic echo killed every TTS playback | revert `6b55b58d` |
| Fuzzy/edit-distance transcript correction | False correction on a safety certificate > a miss | changelog 2026-07-03 "NO fuzzy garble correction (HARD RULE)" (earliest in-repo record; original decision 2026-06-24 per project memory, unverified in-repo) |
| Suppressing low-confidence read-backs to cut chatter | Violates Audio-First #1/#2 | CLAUDE.md invariants; `VOICE_LATENCY_SUPPRESSION=false` in prod |
| Regex tier pre-creating circuits | Deliberately Sonnet-only on both platforms | see `certmate-architecture-contract` |

## 5. Positioning & claims discipline (this skill OWNS this)

**The evidence unit is a field session**: session ID + its
`session-analytics/{userId}/{sessionId}/` bundle (`debug_log.jsonl`,
`field_sources.json`, `manifest.json`) + the derived `analysis.json`. A claim that cannot
cite session IDs is marketing fiction. House precedent: field sessions are cited by ID in
commit messages (F1AC26FB, 15B88D6B, F03B590C…) — hold external claims to the same bar.

| Claim | Status 2026-07-06 | Required before public claim |
|---|---|---|
| "Every dictated reading is read back — nothing silently entered/dropped" | Product law + shipped machinery; **not yet field-proven as a rate** | F4 audit predicate at 100% over ≥3 sessions, both platforms |
| "Hands-free EICR dictation with live structured extraction" | TRUE for the reading/observation/ask loop (16-tool surface) | Cite the tool surface honestly: schedule, signatures, PDF are NOT hands-free yet (F1 gap map) |
| "Zero-touch certification" | **UNEARNED — do not claim** | F1 master milestone (full session, empty allowed-touch list) |
| "Faster than typing / than iCertifi" | UNVERIFIED — no comparative timing exists | Timed same-installation comparison, method published |
| "AI board scan" | True but CONTESTED (iCertifi Board Vision) | Don't lead with it; if claiming accuracy, publish corpus + method (`certmate-ccu-pipeline`), never echo their "95%+" framing without equivalent evidence |
| "New product category: AI certification assistant" | Positioning stance, not a fact claim | Safe as positioning; attach only earned capability claims to it |

**Rules:**
1. Never claim a number without a reproducible source (session IDs, bench script + args,
   or corpus run). Reproducibility standard: another session must be able to re-derive
   the number from the repo + stored artifacts alone.
2. Label everything unproven **open/candidate** — internally and externally. No demo-video
   claims that a field session hasn't survived (demos are curated; sessions are not).
3. Competitor facts get a URL + date-stamp and the CONTESTED table (§2) gets re-verified
   before any external material ships — their release cadence is fast.
4. Novel-vs-known honesty: CCU scan, regs Q&A, compliance checking are KNOWN (shipped by
   a competitor). The candidate-novel set is: enforced exactly-once spoken read-back as a
   product invariant; live multi-turn tool-driven extraction during the inspection walk;
   spoken bulk assertion over an inspection schedule (F3, unbuilt). Claim novelty only
   with the field evidence attached.
5. A milestone is only "reached" when the claim's falsification test was RUN and passed —
   not when the feature merged. Deployment ≠ result (house lesson: green CI has masked
   stale/wrong deploys before; see `certmate-debugging-playbook`).

## 6. How frontier work enters the repo

1. Frontier idea → `/rp` plan (two-reviewer convergence) → `/ep` execution. No direct
   "research spikes" on `main`.
2. Backend-touching frontier work (F3, most of F2's server side) requires the explicit
   cross-platform mandate demanded by the backend-immutable MANDATORY block — surface to
   Derek first.
3. Every client-visible frontier change needs its web companion (or dated
   `web/docs/parity-ledger.md` row with owner) — the WS1 rule.
4. Analyzer/bench-only steps (F1.1, F4.1-3, F5.1) live in `scripts/` and are the
   preferred first move: they produce evidence without touching product code.

## Provenance and maintenance

Date-stamped 2026-07-06. Re-verify before relying on volatile rows:

| Fact | Re-verify with |
|---|---|
| 16 stage6 tools / no inspection-schedule tool | `grep -n "name: '" src/extraction/stage6-tool-schemas.js` |
| Schedule fields excluded from tool enums | `grep -n "inspection_schedule" src/extraction/stage6-tool-schemas.js` (expect no enum wiring) |
| Web prod STT = flux | `grep DEEPGRAM_STT_MODEL ecs/task-def-frontend.json` |
| FINALIZER_TIMEOUT_MS = 8000 | `grep -n FINALIZER_TIMEOUT_MS src/extraction/voice-latency-turn-summary.js` |
| Web capabilities = low_conf_readback_v1 only (fast-path TTS still un-consumed) | `grep -n VOICE_LATENCY_SUPPORTS web/src/lib/recording/sonnet-session.ts` |
| TTS FIFO + cancel_pending_tts shipped | `ls web/src/lib/recording/tts-queue.ts && grep -n cancel_pending_tts src/extraction/dialogue-engine/engine.js` |
| Debug-log S3 upload path | `grep -n debug_log.jsonl src/routes/recording.js` |
| analyze-session usage | `sed -n '1,20p' scripts/analyze-session.js` |
| Bench harness entrypoints | `grep -n "voice-test\|voice-regression" package.json` |
| Live extraction model | `grep SONNET_EXTRACT_MODEL ecs/task-def-backend.json` |
| iCertifi feature set (external, volatile) | web-search `icertifi.co.uk` "Board Vision" / "Spark AI" — re-check before ANY external claim |
| Audio-First invariants wording | `grep -n "Audio-First" CLAUDE.md` |
