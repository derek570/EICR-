# Conversation context — designation-wire-sync (#3.4)

## Section 0 — Handoff folder
Resolved to `<cwd>/.planning-stage6-agentic/handoffs/designation-wire-sync-2026-06-16/` (parent already matched the project convention; no relocation). CWD at invocation was `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified`, but the plan + its folder live in the PARENT repo `/Users/derekbeckley/Developer/EICR_Automation/.planning-stage6-agentic/handoffs/` because this is a cross-repo plan (backend = EICR_Automation, iOS = CertMateUnified). NOTE for the human: if `/ep` is invoked from CertMateUnified it will NOT find this plan by default — invoke `/ep` from `/Users/derekbeckley/Developer/EICR_Automation` (the parent), or pass the handoff folder explicitly, the same way the just-executed `ir-loop-lim-fix` plan was handled.

## Source
Substantive prior conversation. This plan was drafted in the same session that just executed the parent `ir-loop-lim-fix-2026-06-16` plan via `/ep`. #3.4 was a deferred `[contract]` item from that plan; the user explicitly asked for a deeper explanation, then asked for a plan, then (this) `/rp`. Sections 2-6 apply.

## Decisions the user explicitly made
- User asked for a plan for **#3.4 only** (the designation-not-crossing-the-wire bug), NOT #5.3 (atomic swap tool). #5.3 stays out of scope.
- User accepted that #3.4 is genuinely worth scheduling (the orchestrator recommended treating #3.4 as a real bug worth a sprint and #5.3 as low-priority/optional; user proceeded with #3.4).
- The user already greenlit cross-platform (iOS + backend) work for this item by asking for the plan — it IS the resolution of a `[contract]` item, so the backend-immutability "surface first" gate is satisfied.

## Constraints surfaced
- **Backend-immutability rule** (`CLAUDE.md`): `src/`, `config/prompts/*.md`, `config/field_schema.json`, shared-types are SHARED with iOS — changes there are cross-platform and need care; this is why #3.4 was a `[contract]` deferral in the first place.
- **Deploy via CI only** for backend (push `main` → GitHub Actions → ECS); never local `./deploy.sh`. iOS via `deploy-testflight.sh`.
- **No new wire message type** if avoidable — reuse existing channels so iOS renders unchanged (the just-shipped fixes all honoured this).
- **Known stale `TranscriptFieldMatcherTests` failures** (6: bonding ×2, OCPD, polarity, supply-detail, PFC) are pre-existing — must NOT be blind-fixed; they gate a fully-green iOS suite. Separate `ios-test-suite-triage` handoff owns them.
- iOS `deploy-testflight.sh` builds from the ORIGINAL `/Users/.../CertMateUnified` checkout, which is currently dirty / on a stale `ep/` branch — TestFlight is held until that checkout is clean + on main (hard rule against mutating user working state to force a build).

## Alternatives considered and rejected
- **Naive "fire job_state_update on every edit"** — rejected as the framing; the investigation found the backend merge is already fact-vs-reading aware (`_mergeIncomingJobStateIntoSnapshot`, `FACT_FIELDS` includes `circuit_designation`/`designation`), so the merge hazard is already solved. The real gap is iOS not *triggering* the existing sync on designation change, plus debounce/session-scope nuance.
- **Backend-only fix** — rejected as insufficient: the matcher fix (#3.1/#3.2/#3.3) already shipped and only helps once the designation is present; making it present needs iOS (manual edits have no Sonnet involvement) ± prompt steering.
- **#3.4.3 reverse-direction sync (apply server circuit_created/updated on iOS)** — floated, leaning DEFER unless field evidence shows server→iOS drift; currently those events are only logged on iOS.

## Gotchas / hidden requirements (file:line, verified this session via 2 Explore agents + direct read)
- Backend merge path ALREADY EXISTS and is safe: `sonnet-stream.js:970-988` (job_state_update handler) → `eicr-extraction-session.js:1811` `updateJobState` → `:1861` `_mergeIncomingJobStateIntoSnapshot` → `:1921` `_mergeCircuitOrBoardFields`; `FACT_FIELDS` at `:695-697` includes both `circuit_designation` and `designation` → iOS overwrites facts authoritatively, readings only fill empty cells (Sonnet-canonical wins).
- iOS already builds the right payload: `buildJobStateForServer()` at `DeepgramRecordingViewModel.swift:7866-7910` emits `"designation": circuit.circuitDesignation`; sent via `sendJobStateUpdate`. It only fires on CCU extraction (`notifyJobStateChanged(reason:"ccu_extraction")`, `JobDetailView.swift:~550`), board ops (`:6641-6654`), and the debounced `sendJobStateToServer` (`:8001-8003`).
- The MISSING triggers: manual CircuitsTab edit → `viewModel.save()` only (`CircuitsTab.swift:2247-2290`); voice-command apply → `VoiceCommandExecutor.swift:209-210`, no server push.
- Backend Sonnet path: `create_circuit`/`rename_circuit` `designation` is OPTIONAL (`stage6-tool-schemas.js:287-328`, `:337-382`); `upsertCircuitMeta` writes only when `designation != null` (`stage6-snapshot-mutators.js:126`); `dispatchRenameCircuit` upserts meta only when `metaSupplied` (`stage6-dispatchers-circuit.js:625-629,660-669`); bare rekey moves the bucket verbatim (`renameCircuit`, `stage6-snapshot-mutators.js:151-162`).
- `findCircuitsByDesignation` reads `circuit_designation || designation` (`circuit-resolution.js:104,122`) and skips empty → `candidates:[]`.
- Key-shape subtlety: iOS sends `designation` (legacy key); merge writes `target.designation`; `upsertCircuitMeta` writes `circuit_designation`. Resolver's `||` fallback covers both, but other consumers (schedule builder, PDF) should be confirmed not to break — plan flags this as an open question.
- There is NO iOS→server circuit-edit op channel; all create/rename/delete are server-side Sonnet tool calls. job_state_update is the only iOS→server circuit-data push.
- Codex MCP must be invoked with `model: "gpt-5.5"` (project memory).

## Open questions the user deferred
- None deferred by the user directly; the plan itself raises 6 design questions for `/rp` (debounce granularity, session-scope guard, create/push race ordering, designation vs circuit_designation key shape, #3.4.3 scope, whether #3.4.2 prompt steering alone suffices). These should be sharpened, not necessarily resolved, by refinement.
