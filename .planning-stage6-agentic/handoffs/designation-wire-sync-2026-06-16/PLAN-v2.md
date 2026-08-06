# Plan — #3.4: circuit designation must reach the server snapshot

**Date:** 2026-06-16
**Origin:** F1AC26FB voice-feedback fixes (`ir-loop-lim-fix-2026-06-16`). Defect #3 was fixed backend-only (filler-strip + clean echo, shipped in EICR_App PR #55), but its DEEPER cause — `[contract]` item **#3.4** — was deliberately deferred. This plan addresses #3.4.
**Status:** Drafted from a file:line investigation (2 parallel Explore agents + direct trace of the merge path), then refined via `/rp`. Awaiting `/ep` execute.

---

## 0. Scope, cross-platform rule & execution notes

Per the MANDATORY backend-immutability rule, `src/`, `config/prompts/*.md`, `config/field_schema.json`, shared-types are SHARED with iOS. Tags:
- **[iOS]** — Swift change, TestFlight cycle.
- **[shared-prompt]** — edits `config/prompts/*.md`; cross-platform but emits no new message type.
- **[BE-safe]** — backend-only, no wire/schema contract change.
- **[contract]** — touches the iOS↔server data contract — surface before implementing.

This whole plan IS the resolution of a `[contract]` item, so the user has already greenlit the cross-platform work. No NEW wire message type is introduced — the fix reuses the existing `job_state_update` channel.

**Execution notes (read before `/ep`):**
- **`/ep` invocation directory:** this plan + handoff folder live in the PARENT backend repo `/Users/derekbeckley/Developer/EICR_Automation/.planning-stage6-agentic/handoffs/designation-wire-sync-2026-06-16/`. Invoke `/ep` from `/Users/derekbeckley/Developer/EICR_Automation` (the parent), OR pass that handoff folder path explicitly. Invoking `/ep` from `CertMateUnified` will NOT locate this plan by default (its default scan is CWD-relative).
- **Codex MCP model:** any Codex review/refine agent invoked for this handoff MUST be called with `model: "gpt-5.5"` (project memory).

---

## 1. The symptom

Field session F1AC26FB: ring continuity for "the sockets" looped — the server asked "which circuit?" several times, resolving only when the inspector said the literal "circuit 2". CloudWatch at 11:51:58 (and on retry): `entry_designation_matched:false, designation_candidates:[]`. The server-side circuit-2 bucket had an **empty `circuit_designation`** — the name "Sockets" existed only in iOS local state and never reached the server snapshot, so the (correct) matcher had nothing to match.

The backend-only fixes already shipped (#3.1 filler-strip, #3.2 clean echo, #3.3 one-retry) make resolution land **once the designation is present**. #3.4 makes it present.

---

## 2. Root cause (verified, file:line)

The gap is two-pronged. The infrastructure to close it largely EXISTS but (a) isn't triggered on iOS designation changes and (b) has two latent merge correctness gaps that must be fixed for the trigger to be reliable.

### 2a. Backend — designation is OPTIONAL on the Sonnet tool path (and can be silently absent)
- `create_circuit` schema: `required: ['circuit_ref']` only — `designation` is optional and modelled as `anyOf:[{type:'string'},{type:'null'}]` with the description "Null if unknown" (`src/extraction/stage6-tool-schemas.js:287-328`, designation field ~:296-306), which actively INVITES Sonnet to emit `designation:null`. `rename_circuit` likewise (`:337-382`).
- `upsertCircuitMeta` writes `circuit_designation` ONLY when `designation != null` (`src/extraction/stage6-snapshot-mutators.js:126`); it never clears, but it also never invents. It deliberately writes the CANONICAL `circuit_designation` key (NOT legacy `designation`) — see the comment at `:120-126` citing prod loop 286D500D (2026-05-24), where writing the legacy key made tool-loop-created circuits invisible to the canonical-key resolver.
- `dispatchCreateCircuit` passes `input.designation` straight through (`src/extraction/stage6-dispatchers-circuit.js:489-496`); if Sonnet omits it, the bucket is created with no designation.
- `dispatchRenameCircuit` only upserts meta when `metaSupplied` is true (`src/extraction/stage6-dispatchers-circuit.js:625-629, 660-669`); a bare rekey moves the bucket verbatim (`renameCircuit`, `src/extraction/stage6-snapshot-mutators.js:151-162`) — so a designation-less bucket stays designation-less through create→rename churn.
- `findCircuitsByDesignation` skips any bucket whose `circuit_designation || designation` is empty (`src/extraction/dialogue-engine/helpers/circuit-resolution.js:104-105, 122-123` + the `continue` guard) → `candidates:[]`.

**Net:** if Sonnet's `create_circuit(ref:2)` omits the designation (schema-legal, and what happened in F1AC26FB), the server never learns "Sockets" from the tool path.

### 2b. iOS — the designation IS known locally, but the sync that would push it isn't triggered on designation changes
- iOS stores the designation in `Circuit.circuitDesignation` (`Sources/Models/Circuit.swift:10`).
- iOS ALREADY has a full job-state push that INCLUDES the designation: `buildJobStateForServer()` emits `"designation": circuit.circuitDesignation` per circuit (`DeepgramRecordingViewModel.swift:7866-7910`, designation at :7870, boardId at :7907), sent via `serverWS.sendJobStateUpdate(...)`.
- Existing send triggers: (a) CCU photo extraction (`notifyJobStateChanged(reason:"ccu_extraction")`, wired at `JobDetailView.swift:549-551` via `extractionVM.onCircuitsApplied`, `[weak recordingVM]`), (b) server board ops (`applyBoardOps`, `:6641-6654`), (c) after server circuit-update application + session resume paths (`:6368-6370`, `:7841-7843`), (d) the debounced `sendJobStateToServer()` (`DeepgramRecordingViewModel.swift:8001-8003`) called from `notifyJobStateChanged(reason:)` (`:8022-8029`).
- **The MISSING triggers (the actual gap) are designation EDITS:**
  - Manual UI edit in CircuitsTab → `viewModel.save()` (local DB only), no `notifyJobStateChanged` (`Sources/Views/JobDetail/CircuitsTab.swift:2247-2290`). **CircuitsTab has NO recording-VM reference** — it is constructed at `JobDetailView.swift:478-483` with only `(viewModel, circuitsVM, showDeleteConfirmation, focusedCircuitField)`. The CCU trigger lives in `JobDetailView`'s scope, NOT inside CircuitsTab. So a fix here REQUIRES new plumbing (a callback), not a direct call.
  - Voice-command apply → `VoiceCommandExecutor.execute(...)` mutates `jobVM.job.circuits[idx].circuitDesignation` (`Sources/Recording/VoiceCommandExecutor.swift:209-210`). **VoiceCommandExecutor is a standalone `final class`** (`:13`) whose `execute(action:jobVM:)` (`:28`) receives only a `JobViewModel` — it has NO recording-VM/`serverWS` reference and CANNOT trigger a push. The push must be fired by the CALLER (`DeepgramRecordingViewModel`), which invokes `execute` from both `handleVoiceCommandResponse` (~`:9203-9212`) and `handleLocalApplyField` (~`:9374-9387`) (3 call sites total: ~9204/9293/9375).
- **No iOS→server circuit-edit op channel exists** — all create/rename/delete are server-side Sonnet tool calls; `job_state_update` is the ONLY iOS→server circuit-data push. Do NOT invent a new op for this fix; iOS-originated circuit facts MUST ride the existing `job_state_update` payload.
- Server→iOS `circuit_created`/`circuit_updated` events are RECEIVED but only **logged**, not applied to the local model (`DeepgramRecordingViewModel.swift:8304-8320`) — so the two sides can also drift in the other direction (relevant to #3.4.3 below).

### 2c. The backend merge is fact-aware — but has two correctness gaps that must be closed
The server's `job_state_update` handler (`src/extraction/sonnet-stream.js:970-988`) calls `session.updateJobState` → `_mergeIncomingJobStateIntoSnapshot` (`src/extraction/eicr-extraction-session.js:1811-1903`), which merges with **fact-vs-reading precedence** (`_mergeCircuitOrBoardFields`, `:1921-1938`): `FACT_FIELDS` (which includes both `circuit_designation` and `designation`, `:695` set, entries at ~`:698-699`) are written authoritatively from iOS, while READINGS only fill empty cells (Sonnet-canonical wins). Built in the snapshot-restructure sprint 2026-05-27. So the fact-vs-reading hazard (clobbering Sonnet readings) is already solved.

**However, two correctness gaps remain (both REQUIRED fixes, see #3.4.4 / #3.4.5):**
1. **Key-shape gap.** `buildJobStateForServer` sends the LEGACY key `designation`; `_mergeCircuitOrBoardFields` writes it verbatim as `target.designation` (`:1925-1926`), NOT canonical `target.circuit_designation`. If the bucket already holds a STALE `circuit_designation` (e.g. an old/wrong Sonnet value), `findCircuitsByDesignation`'s `circuit_designation || designation` (`:104, :122`) picks the stale canonical value and the iOS edit is IGNORED. The whole "merge is safe" claim currently rests on that single `||` fallback AND contradicts the 286D500D canonical-key lesson.
2. **Board-routing gap.** `_mergeIncomingJobStateIntoSnapshot` keys circuits by `ref` ONLY (`:1865-1879`), ignoring the incoming `board_id`/`boardId`. Session seeding already routes sub-board circuits to composite keys (`${boardId}::${ref}`) via `_seedStateFromJobState` (~`:1516-1525`), so a later ref-only merge of sub-board circuit 1 can OVERWRITE main circuit 1 (and vice-versa). On multi-board jobs an iOS designation push could land on the wrong board's bucket.

---

## 3. Proposed fix

### Fix #3.4.1 — [iOS] PRIMARY: trigger a commit-aware, debounced job-state sync when a circuit designation changes
Reuse the EXISTING `notifyJobStateChanged` → `buildJobStateForServer()` → `sendJobStateUpdate` path (the server already merges it; no new message type). There is NO iOS→server circuit-edit op channel — iOS facts ride `job_state_update`. Two trigger sites, each needing real plumbing:

1. **Manual CircuitsTab edit.** CircuitsTab has no VM reference, so ADD a closure to the struct: `var onFactFieldChanged: (String) -> Void` (or pass the recordingVM). Wire it from `JobDetailView.swift:478-483` at construction as `{ reason in recordingVM?.notifyJobStateChanged(reason: reason) }`, mirroring the `extractionVM.onCircuitsApplied` pattern at `:549-551`.
   - **Commit-aware, NOT per-keystroke (load-bearing).** Do NOT call `onFactFieldChanged` directly from `setCircuitField` (`CircuitsTab.swift:2247-2290`) — that setter is reached from `Binding.set` on EVERY keystroke (`:2076-2079`), so calling there would push partial half-typed designations, the explicitly-rejected "fire on every edit" anti-pattern. Instead: after `viewModel.save()` (`:2290`) mark the fact field / `localId` dirty, then fire the callback ONLY on TextField commit or focus-loss (`focusedCircuitField` transitioning away from that cell), or via a dedicated final-value debounce SEPARATE from the existing 250 ms batch debounce. The callback must run after the final `viewModel.save()`. Scope to FACT fields (at least `circuit_designation`; consider the full FACT set). Keep the 250 ms debounce only for batch mutations (CCU extraction / board ops).
2. **Voice-command apply.** Do NOT edit `VoiceCommandExecutor` (it has no push access). Instead, hook the CALLER in `DeepgramRecordingViewModel`: after `voiceCommandExecutor.execute(...)` returns at BOTH `handleVoiceCommandResponse` (~`:9204`) and `handleLocalApplyField` (~`:9374`) (and the third site ~`:9293`), call `self.notifyJobStateChanged(reason:"designation_edit")` WHEN the executed action updated `circuit_designation`/`designation` (or a chosen FACT field). Either have `VoiceCommandExecutor.execute` return a mutation-result naming the changed field, or gate on the action's field at the call site. All applicable call sites must be covered.

**`reason` plumbing:** `sendJobStateUpdate` has NO `reason` parameter and `notifyJobStateChanged(reason:)` logs the reason LOCALLY only (`:8022-8029`); the server's `job_state_update` log line shows `msg.reason || 'unspecified'`. DECISION: treat `reason` as a local iOS diagnostic — do NOT claim it reaches the server. If server-side attribution of "designation_edit" pushes is wanted, add `reason` to the jobState dictionary in `buildJobStateForServer` + extend `sendJobStateUpdate`/the protocol — but that is OPTIONAL and not required for correctness.

**Why this is the right primary fix:** lowest risk, reuses proven merge-aware plumbing, no new message type, fixes BOTH the manual-edit and voice-apply gaps, and only sends during/around an active session where the server snapshot matters.

### Fix #3.4.2 — [shared-prompt] SECONDARY: add a NEGATIVE designation-on-create instruction
The existing `config/prompts/sonnet_agentic_system.md` ALREADY instructs designation-on-create POSITIVELY — `create_circuit({circuit_ref:N, designation:"X"})` in the CIRCUIT NAMING block (~:50-56), "create_circuit IMMEDIATELY with next free circuit_ref + that designation" (DESCRIPTION MATCHING), and the MERGED/STUTTERED example. So the residual gap is the absence of an EXPLICIT NEGATIVE instruction countering the schema's `designation` "Null if unknown" wording. Add a clause near the CIRCUIT NAMING block: *"NEVER issue a designation-less `create_circuit` for a clearly-named circuit — do not emit `designation:null` when the inspector spoke a name."* Cert-agnostic, no iOS twin, one cached-prefix edit. SECONDARY and NOT sufficient alone: manual UI edits have no Sonnet involvement, so #3.4.1 is still required.

### Fix #3.4.3 — [iOS, DEFERRED] reverse-direction sync: apply server circuit_created/circuit_updated locally
Currently `serverDidReceiveCircuitCreated/Updated` only log (`DeepgramRecordingViewModel.swift:8304-8320`). Applying the designation to the local model would keep iOS in lockstep with server-side Sonnet creates/renames. **DEFERRED** unless CloudWatch shows server→iOS designation drift; risk is double-application races with the iOS-authoritative push (#3.4.1). Not in this sprint's execution scope — listed so `/ep` does NOT implement it.

### Fix #3.4.4 — [BE-safe] REQUIRED: normalise designation to the canonical key — CIRCUIT BUCKETS ONLY
In `_mergeCircuitOrBoardFields` (`src/extraction/eicr-extraction-session.js:1921-1938`): when the incoming field is `designation` OR `circuit_designation`, write the value to the CANONICAL `circuit_designation` (and keep/clear the legacy `designation` alias consistently) so a stale `circuit_designation` cannot shadow a fresh iOS `designation` via the resolver's `||`. Cite the 286D500D canonical-key lesson (`src/extraction/stage6-snapshot-mutators.js:120-126`).

**CRITICAL — scope to circuit buckets only.** `_mergeCircuitOrBoardFields` is SHARED by the circuit, supply, AND board branches (`:1878, :1885, :1900`). iOS sends BOARD designations as `boards[n].designation` and backend prompt rendering reads `board.designation` — so blindly aliasing `designation`→`circuit_designation` here would CORRUPT board designations. Pass a `kind` argument (`'circuit'` | `'board'` | `'supply'`) into `_mergeCircuitOrBoardFields` (or pre-normalise only in the circuit branch): for `kind==='circuit'` apply the alias→`circuit_designation` mapping; for `kind==='board'` keep `target.designation` unchanged; for `'supply'` do not apply circuit-designation aliasing. [BE-safe — internal merge logic, no wire/schema change.]

### Fix #3.4.5 — [BE-safe] REQUIRED: make the merge board_id-aware AND seed the dual-shape skeleton
In `_mergeIncomingJobStateIntoSnapshot` (`src/extraction/eicr-extraction-session.js:1865-1879`): select the target bucket using the incoming `board_id ?? boardId` with the SAME keying rule as `_seedStateFromJobState` (~`:1516-1525`) — legacy numeric key for the main board (via `getMainBoardId`), composite `${boardId}::${ref}` for sub-boards.

**CRITICAL — selecting the composite key is NOT sufficient.** The dual-shape readers require a SELF-DESCRIBING bucket: `listCircuitRefsInBoard` (`src/extraction/stage6-multi-board-shape.js:104-110`) only returns a ref when `bucket.board_id === id && Number.isInteger(bucket.circuit)`, and `findCircuitsByDesignation`'s dual-shape branch (`circuit-resolution.js:113-127`) relies on it. But `_mergeCircuitOrBoardFields` SKIPS `board_id` (it is in `MERGE_SKIP_KEYS`, ~`:825-832`) and never sets `circuit`. So when the merge FIRST-CREATES a sub-board composite bucket it MUST seed the skeleton `{ circuit: Number(ref), board_id: incomingBoardId }` (mirroring `_seedStateFromJobState:1519-1523`) BEFORE merging fields — otherwise the bucket is invisible to the resolver and the designation still never lands on multi-board jobs. Also: `MERGE_SKIP_KEYS` skips `board_id` but NOT the iOS camelCase `boardId` — strip BOTH (add `boardId` to `MERGE_SKIP_KEYS`, or strip both before the field loop) so `boardId` can't leak into the bucket/prompt as a reading field. [BE-safe.]

---

## 4. Resolved decisions (were open questions; this plan IS the `/rp` input, so they are decided here)

1. **Debounce / commit semantics:** manual CircuitsTab trigger is COMMIT-AWARE (`.onSubmit`/focus-loss or a final-value-only debounce after `save()`), NOT per-keystroke — see #3.4.1.1. Batch paths keep the existing 250 ms debounce.
2. **Session scope:** `job_state_update` is only meaningful during an active recording session (the snapshot is per-session). There is no iOS→server edit-op channel, so a designation edit made with NO live session does not sync at edit time — it reaches the server on the NEXT session's initial push (`sendSessionStart` carries `jobState` via `buildJobStateForServer`). The out-of-session no-op is ALREADY guaranteed at the transport level: `notifyJobStateChanged`'s doc comment states it is safe to call when no session is active because `serverWS.sendJobStateUpdate` no-ops when the WebSocket isn't connected (`DeepgramRecordingViewModel.swift:8020-8030`). So do NOT add a new session guard — just confirm at execution that the session-start path sends the current circuit designations. For F1AC26FB the naming happened DURING the session (voice), which #3.4.1.2 covers.
3. **Create/push race ordering:** Sonnet may `create_circuit(ref:2)` designation-less while iOS applies "Sockets" locally and pushes. With #3.4.4 (canonical-key write) the `FACT_FIELDS` overwrite must land the iOS name regardless of arrival order — REQUIRE a test proving this (see §6).
4. **Key shape:** RESOLVED as REQUIRED fix #3.4.4 (normalise to `circuit_designation`), not left open.
5. **#3.4.3 scope:** DEFERRED (see #3.4.3) — not implemented this sprint.
6. **Is #3.4.2 alone enough?** No — #3.4.1 is required for the manual-edit (non-Sonnet) path. #3.4.2 is secondary defence for the pure-voice path.

---

## 5. Sequencing & deploy

1. **Backend wave:** #3.4.4 + #3.4.5 (merge correctness, [BE-safe]) + #3.4.2 (shared-prompt) → `npm test` → push `main` → CI/GitHub Actions only → ECS (`gh run watch`). Never local `./deploy.sh`.
2. **iOS wave:** #3.4.1 → `xcodebuild test` (respect the known stale `TranscriptFieldMatcherTests` failures — do NOT blind-fix). Then TestFlight, SUBJECT TO the precondition below.
   - **TestFlight precondition (hard):** `deploy-testflight.sh` builds from the ORIGINAL `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified` checkout. That checkout must be CLEAN and on `main` before the build. It is currently dirty / on a stale `ep/` branch; per the no-mutate-user-working-state rule, `/ep` must NOT stash/checkout to force the build. If the checkout is not clean+on-main, LAND + test the iOS code (merge the PR) and HOLD the TestFlight push for the human, logging the hold — do not force it.
3. Backend FIRST (standing ordering rule), though there is no hard schema dependency between the waves here.

## 6. Test plan
- **Backend #3.4.4 (key normalisation):** a `_mergeCircuitOrBoardFields` / `updateJobState` test where a bucket starts with `circuit_designation:'Sockets'`, iOS pushes `designation:'Kitchen'`, and `findCircuitsByDesignation` then matches **Kitchen**, not Sockets (proves the canonical key is rewritten, not shadowed).
- **Backend #3.4.4 (board designations NOT corrupted):** a `boards[]` `job_state_update` carrying `designation` updates `stateSnapshot.boards[n].designation` (the board key), proving the circuit-only canonicalisation does not move/clear board designations into `circuit_designation`.
- **Backend #3.4.5 (board routing + resolves):** a test with main circuit 1 AND sub-board circuit 1 where an iOS `job_state_update` designation update for the sub-board lands ONLY on the `${boardId}::1` composite bucket, does NOT overwrite main circuit 1, AND — crucially — `findCircuitsByDesignation`/`listCircuitRefsInBoard` actually RESOLVES the sub-board designation (proving the `{circuit, board_id}` skeleton was seeded, not merely that the bucket exists). Include a case where the sub-board circuit was PREVIOUSLY ABSENT and is first-created by the merge.
- **Backend (race order / reading-preservation):** an iOS `job_state_update` with `circuits:[{ref:2, designation:"Sockets"}]` lands the designation on a bucket Sonnet created designation-less, WITHOUT clobbering an existing Sonnet-written reading on that bucket; `findCircuitsByDesignation` then resolves "the sockets" → ref 2.
- **Backend #3.4.2:** a prompt-invariant test asserting the NEW explicit NEGATIVE clause ("NEVER issue a designation-less create_circuit for a clearly-named circuit / do not emit designation:null when the inspector spoke a name") is present in `sonnet_agentic_system.md` — NOT the generic positive "include the spoken name" guidance that already exists.
- **iOS #3.4.1:** a test that a committed `circuit_designation` change (manual CircuitsTab path and the voice caller-side path) enqueues a `sendJobStateUpdate` whose payload carries the new designation; specifically, typing MULTIPLE characters into a designation cell sends EXACTLY ONE update containing the final value (proves commit-aware, not per-keystroke); no send fires when no session is active (transport no-op).
- **End-to-end (manual / field):** re-run the F1AC26FB ring-continuity flow — name circuit 2 "Sockets", give ring readings referring to "the sockets" → resolves first time, no "which circuit?" loop.

## 7. Out of scope
- #5.3 (atomic swap tool) — separate `[contract]` item, not addressed here.
- #3.4.3 reverse-direction sync — deferred (see §3).
- The 6 pre-existing stale `TranscriptFieldMatcherTests` failures — separate `ios-test-suite-triage` handoff.
