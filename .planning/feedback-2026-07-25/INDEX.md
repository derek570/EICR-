# Field-feedback wave 2026-07-25 — plan index

Source: voice-feedback reports pulled from prod (`Voice feedback captured` CloudWatch rows + S3 `session-analytics/…`), investigated against client realtime debug logs and backend/client source. Sessions:

- `2D8E432D` (iOS, **pre**-P1–P8 backend — recorded before task-def `:344` / TestFlight 421) — feedback ids **93–99**
- `C06B9904` (iOS, **post**-wave: backend `:344`, iOS build 421) — feedback ids **100–101**

The `:344` + build-421 deploy (2026-07-24 15:33 BST) is the pre/post boundary. Two `2D8E432D` reports are already addressed by that deploy and are **not** re-planned:

| id | Symptom | Disposition |
|---|---|---|
| **94** | Read-back spoken, value silently reverted | **ALREADY FIXED** by the deployed P2 + P5. Evidence: value-less dedupe key `r1_r2_ohm_12` (the exact P2/id-84 defect) plus a same-turn `stage6_field_cleared` wiping the 0.30→0.37 write (the exact P5/T10 defect). **Do not re-plan** — see §Verification below. |
| **93** | Ring script answered a delete request with "are they okay?" | **LIKELY FIXED** by the deployed P1 confirmation-gated delete preflight (both live probes passed at ship time). **Verification only** — see §Verification. |

Everything else is open and mapped below.

| Plan | Feedback ids | Repo(s) | Verification lane |
|---|---|---|---|
| [D — read-back reflects the stored value](plan-d-readback-reflects-stored-value.md) | 100(b) | backend + `packages/shared-utils` + web + iOS | unit + recorded fixture + device smoke |
| [C — retire the iOS misheard-clarification net](plan-c-misheard-net-retire.md) | 95, 96, 97 | iOS only | unit + device smoke (TestFlight) |
| [A — `clear_board_reading` tool](plan-a-clear-board-reading.md) | 101 | backend only | unit + recorded fixture |
| [F — leading-circuit scope in dialogue-script entry](plan-f-leading-circuit-scope.md) | 98 | backend only | unit + replay parity + recorded fixture |
| [B — honest refusal vs "didn't catch that"](plan-b-honest-refusal.md) | 101 (secondary) | backend only | unit + recorded fixture |
| [E — "main earth" → `earthing_conductor_csa` steer](plan-e-main-earth-steer.md) | 100(a) | backend (prompt only) | LIVE-lane probes post-deploy |
| [G — iOS LIM two-tap UI bug](plan-g-ios-lim-two-tap.md) | 99 | iOS only | unit/snapshot + device smoke |

## Recommended execution order

1. **D** — safety-critical. A measured impedance is silently divided by 10 client-side while the read-back speaks the *undivided* value. The inspector hears one number and the certificate carries another. Highest severity in the wave.
2. **C** — the loudest live UX defect (ids 95/96/97 are one bug, not three). A fixed 6.0s client timer races a variable-latency server and nags "did I mishear?" on readings the system already understood. By its own source comment the net provides **zero** drop coverage that the server-side orphan/audibility nets don't already provide.
3. **A** — Derek's explicit ask: *"if it can't do something why is it asking me to say the same thing again"*. Board/supply-scope clears have no tool, so every attempt draws a marker-② apology. Mirrors the 2026-05-04 `delete_circuit` precedent exactly.
4. **F** — deterministic parse bug; small, well-bounded, fixture-lockable.
5. **B** — depends on **A** landing first (A supplies the "capability exists / doesn't exist" signal B branches on).
6. **E** — single prompt edit, one cache invalidation, live-lane verification only. Ships last so it is tested against the fixed deterministic layers.
7. **G** — isolated iOS UI bug; independent of everything else, rides the same TestFlight build as C.

D, C, A, F, G are mutually independent (disjoint files). B depends on A. E depends on nothing but is ordered last by convention (prompt-cache invalidation).

## Integration notes across seams

- **D ↔ C** — both land on iOS. D changes what the client *stores*; C removes a client net that *reacts* to readings. They touch different regions of `DeepgramRecordingViewModel.swift` (≈5420–5490 vs ≈3380–3412 / 4633–4840) but the same file — if executed in parallel, expect a merge in that file and re-run the iOS test suite after both land.
- **D ↔ A/B** — id 100(b) left a bogus `ze = 1.6` in the job, which is *why* Derek then tried "Delete Ze" (id 101). Fixing D removes the trigger; A/B fix the response. Both are still needed: D stops the corruption, A/B make the recovery path work.
- **A ↔ B** — A adds the capability; B changes what the server says when a capability genuinely doesn't exist. Land A first so B's trigger set is the *post-A* residue, not the pre-A one.
- **A ↔ F** — no file overlap (`stage6-tool-schemas.js` + dispatcher vs `dialogue-engine/schemas/*` + the legacy twin).
- **F** must change the **live** schema (`src/extraction/dialogue-engine/schemas/ring-continuity.js`, `…/insulation-resistance.js`) **and** the legacy twin (`src/extraction/ring-continuity-script.js`) in lock-step — the twin carries an explicit byte-parity contract enforced by `dialogue-engine-replay.test.js`.
- **C, G** ride ONE TestFlight build. **D** needs both a backend deploy *and* the same TestFlight build (+ one web deploy) — sequence the backend merge first and confirm ECS rollout before the iOS build, per the hub's schema-coordination rule.
- **Shared-test-file rule (MANDATORY):** A, B, D all add tests under `src/__tests__/stage6-*`. If run as parallel workstreams, re-run the FULL backend suite on `main` between merges.
- **Backend-immutability escalation:** plan **D** deliberately moves impedance clamping server-side and touches `packages/shared-utils`. That is a cross-platform change to a shared contract, not a PWA-only fix — it is called out explicitly in D's own "Backend-immutability escalation" section and must be confirmed with Derek before execution.

## Verification (no code change)

Not plans — two checks to run against the next field session, recorded here so they are not lost:

- **id 94** — confirm a spoken correction now (a) speaks (P2 value-aware dedupe key) and (b) survives the turn (P5 same-turn clear→write collapse). Expected: dedupe key carries a text hash; no `stage6_field_cleared` for a slot with a surviving write in the same turn.
- **id 93** — confirm "delete the ring readings" reaches `clear_reading` rather than the ring script's "are they okay?" confirmation. P1's confirmation-gated delete preflight shipped with two passing live probes; this is a regression watch, not an open bug.

Both belong in the vault todo list (`todos-certmate.md`) as post-deploy field checks.

---

## ⚠ Post-authoring forensics corrections (2026-07-25, peer sessions)

Two independent forensics passes re-derived both sessions from **CloudWatch `filter-log-events` over the full window** (3975 events, real epoch-ms per `Client log batch entry`) rather than from client-log ordering. That is stronger evidence than this wave was authored on, and it **corrects four things**. Nothing below invalidates a plan's *change*; it corrects **scope, attribution and disposition**.

### C1 — id 93 is **STILL OPEN**, not "likely fixed by P1"

P1's "Deploy to AWS ECS (Production)" job for PR #107 **succeeded 2026-07-22T17:17:21Z — 17+ hours BEFORE session `2D8E432D`** (2026-07-23 10:32–10:49 UTC). So P1's ring-script code *was already live* and the bug fired anyway.

Mechanism: `ring-continuity.js:111` `entryExclusionPattern` is tested **only against the utterance that matches the trigger** (`:96`,`:98` via `engine.js:411`). Here "delete" (10:33:03) and "recontinuity readings for circuit 13." (10:33:09) were **two separate STT-finalised utterances**. The guard has no cross-utterance memory; `engine.js:372-385`'s veto only suppresses a *different schema* re-processing the *same text*.

P1 closed the **same-utterance** case only (see `engine.js:394-398`'s own comment). **Action:** id 93 needs a fix. Natural seam — **fold into plan F**: same file (`ring-continuity.js`), same concern (script-entry trigger/guard), one shippable unit. Update the "already addressed, do not re-plan" table above.

### C2 — ids 95 / 96 / 97 are **not one bug**; plan C owns only part of 97 (and part of 96)

| id | Actual proximate mechanism | Owner |
|---|---|---|
| **95** | Byte-identical transcript → two different live-model outcomes on consecutive turns (turn-9 zero tool calls; turn-10 identical text writes correctly, resolving "sockets living bedroom" → circuit 12 by designation). Presents as Sonnet sampling non-determinism on designation-based circuit resolution. **No owning fix; MEDIUM confidence.** | **none** — log as open investigation, do not plan (can't be specified yet) |
| **96** | Two contributors: (a) the misheard net + backend catch-all both nagging "say it again" (plan C's target); (b) **NEW BUG** — "No. No." is **silently dropped**. `TranscriptGate.shouldForward` (`DeepgramRecordingViewModel.swift:91`) matches `^(no\|nope\|nah)[.!?]*$` = exactly ONE token; two tokens fall through to `return false` (`:3339`) → `transcript_gate_blocked` (`:3376`), no chime, no TTS, total silence. Mirrored server-side at `pre-llm-gate.js:451`. A single "No." forwarded correctly in the same session, proving the mechanism. | plan C (partial) + **new plan** |
| **97** | Baseline ~3.2s median turn latency (the open 2026-06-05 voice-latency Phase 2.2 gap) **+ dual-apology stacking** — backend orphan apology at ~2s AND the iOS misheard net at +6-13s, uncoordinated, for one utterance (`preTTSAgeMs:6053`). The LIM-driven 20.9s spike is separately **ALREADY FIXED** by P3. | plan C (the stacking half only) |

**Action:** narrow plan C's stated scope from "fixes 95/96/97" to *"removes one of two uncoordinated 'say it again' sources — the stacking half of 97 and the nagging half of 96"*. Its **change is unaffected and its evidence is strengthened**: the net firing a second time for an already-answered utterance is directly observed.

### C3 — NEW bug: multi-token standalone negation silently dropped

"No. No." (or any ≥2-token bare negation) is blocked on **both** the iOS gate and the backend mirror. A dictated correction is silently discarded — an Audio-First violation, though not a "chime is a promise" one (the block is pre-chime). Cross-platform: iOS `:91` + `src/extraction/pre-llm-gate.js:451` + presumably the web gate port. **Needs its own plan** (post-wave).

### C4 — NEW: "sticky wrong field" `ask_user` is the real root cause of id 100's "2 goes"

Once the model mis-routed "Main earth is 16" → `earth_loop_impedance_ze`, its clarifying re-ask stayed **pinned to that wrong field** ("what was the Ze reading?"), so Derek's next full utterance was consumed as the *answer* to the wrong-field ask and written to Ze **again**. Only the third attempt escaped. **Action:** plan E currently only steers "main earth" → `earthing_conductor_csa`; add the re-ask-should-re-open-field-choice concern to plan E's scope (or a sibling plan) — the steer alone would not have broken this loop.

### C5 — NEW: residual bogus `Ze` is a silent certificate data-integrity risk

Every erroneous `earth_loop_impedance_ze` write from the id-100 misroute **survives**, because `clear_reading` structurally cannot touch supply-scope fields (the id-101 gap). In this session Ze was only fixed **incidentally** at 08:02:14 by an unrelated "Zero is 0.86" utterance caught by the ze regex. **This raises plan A's severity** from UX annoyance to data integrity, and is the strongest argument for A landing early.

### Confirmed unchanged

- **Plan D's premise** — client auto-divided 16 → 1.6 as an implausible-value correction while speaking "Ze 16". Confirmed verbatim. (D has already converged and is executing.)
- **Plan A's mechanism** — `CLEAR_READING_FIELD_ENUM` (`stage6-tool-schemas.js:281-283`) is built **exclusively** from `fieldSchema.circuit_fields`; `earth_loop_impedance_ze` lives in `supply_characteristics`, so `field_not_clearable` (`stage6-dispatch-validation.js:256-267`) fires deterministically. **6 byte-identical rejections** logged. 100% model intent recognition — the model called the right tool on the right field every time; the tool simply cannot succeed.
- **Plan B's premise** — the rejections route into `REJECTED_PROMPTS` ("could you repeat it?") and once into marker-②. Derek's diagnosis is exactly right: repeating can never work.
- **Plan G's mechanism** — `JobDetailView.swift:1058-1093`; `writeFocusedCellValue` (`:959-974`) guards `guard let focused = focusedCircuitField … else { return }` — a **silent** no-op on transient focus loss. The web twin explicitly defends this exact class via `onPointerDown`+`preventDefault`. MEDIUM confidence (no device telemetry; the guard logs nothing by design).
- **id 94** — ALREADY FIXED by P2 (`buildConfirmationDedupeKey` → `{field}_{circuit}_{djb2(text)}`). Session ran build **420**; fix ships in **421**. A *third* unreported instance of the same class was found at 10:35:07 (`measured_zs_ohm_11`).
- Only **one** real WS disconnect in `2D8E432D` (10:46:44, <10ms, clean, after the id-96 report) and **one** Deepgram-side Flux error in `C06B9904` (07:59:42–46, ~100ms audio lost, client recovered). Both users' "keeps disconnecting" framing is **misattribution** — as this wave already concluded.
