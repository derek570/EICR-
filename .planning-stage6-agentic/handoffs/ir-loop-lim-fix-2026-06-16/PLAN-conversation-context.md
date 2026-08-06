# Conversation context — PLAN refinement (session 2026-06-16)

## Section 0 — Handoff folder
- LIVE_PATH resolved to `.planning-stage6-agentic/handoffs/ir-loop-lim-fix-2026-06-16/PLAN.md` (parent already a canonical handoff folder; no move needed). STEM=PLAN.
- Folder slug `ir-loop-lim-fix-2026-06-16` originated from the first task (IR/LIM loop only); the plan was later expanded to cover all 5 session defects. The slug name is now slightly narrow vs scope — cosmetic only, not worth renaming.

## 1. Source
Substantive prior conversation. This session: found all backend voice-feedback logs, traced session F1AC26FB end-to-end, then did 4 parallel file:line root-cause investigations (defects #1,#2,#3,#5; #4 traced directly). The plan is the output. Sections 2-6 apply.

## 2. Decisions the user explicitly made
- **Investigate then plan ALL FIVE** session-F1AC26FB feedback markers, not just the IR loop. User: "I would like a definitive investigation and then plan into all five of these."
- **#4 LIM → store as the canonical sentinel string `"LIM"`** in `ir_live_*_mohm` (NOT mapped to `>999`). Chosen via AskUserQuestion ("Store as LIM sentinel").
- **Deliverable = a plan**, not direct implementation. User answered the scope question with "Write into plan" (not "implement now").
- Originally (first task) user asked specifically why the IR loop "keeps refiring" — that became defect #4 and the seed of the plan.

## 3. Constraints surfaced
- **Backend is SHARED with iOS and immutable during PWA work** (project CLAUDE.md MANDATORY rule). `src/`, `config/prompts/*.md`, `config/field_schema.json`, shared-types. Any change iOS sees must be surfaced before touching. Plan tags every fix [BE-safe] / [shared-prompt] / [iOS] / [contract] accordingly.
- **Deploy backend via GitHub Actions only** (push main → CI → `gh run watch`); never local deploy.sc-style. iOS via `deploy-testflight.sh`.
- **Infra changes must come from source** (task-def etc.) — not directly relevant to this plan but a standing rule.
- Known: a set of **stale `TranscriptFieldMatcherTests` failures** (dates/polarity/OCPD/PFC) pre-exist and block the green-suite TestFlight gate — do NOT blind-fix expectations. Relevant to #1's iOS test wave.

## 4. Alternatives considered and rejected
- **LIM → `>999` saturation mapping: REJECTED.** User chose "store as LIM sentinel" instead. The plan must NOT map LIM to >999.
- **Atomic `swap_circuits`/`reorder_circuits` tool (#5.3): DEFERRED**, not adopted now. Reason: it emits a new op the iOS applier routes to a `default:`/unknownOps branch, so it silently no-ops until a companion TestFlight ships. Prompt-rule fix (#5.1) makes a designation swap expressible with existing `rename` ops today. Revisit only for true positional reorder.
- **Bundling all 5 into one undifferentiated fix: REJECTED** — kept defect-by-defect with separate parity tags and a backend-then-iOS sequencing.

## 5. Gotchas / hidden requirements
- **#3 deeper cause is a data-contract gap [contract]:** the circuit designation ("Sockets") existed only in iOS client telemetry and never crossed the wire to the server snapshot (create/rename churn; `upsertCircuitMeta` only writes designation when non-null, `stage6-snapshot-mutators.js:126`). The cheap BE-safe fixes (#3.1-#3.3) only help once the designation IS present server-side. The upstream fix (#3.4) changes what iOS pushes → must be surfaced to Derek before implementing, NOT bundled.
- **Stale "dead code" comments** in `schemas/ring-continuity.js:30-39` (and an IR twin) claim the legacy script is live — it is NOT; the dialogue engine is live (`sonnet-stream.js:82,3463`). Plan says delete them.
- **#1 has TWO stacked causes** (feedback-window swallow + adjacent-tn earthing regex) — both must be fixed or earthing still flakes.
- **#5 ref 999 is model-invented, not a code sentinel** (the only 999 in code is the IR meter `>999` reading value). `validateCreateCircuit` has no ref plausibility bound.
- **Codex MCP** must be invoked with `model: "gpt-5.5"` (per project memory) for these reviews.
- **iOS regex was already correct for #2** (`TranscriptFieldMatcher.swift:642` tails→mainSwitchConductorCsa) — the fix is backend-prompt-only; iOS needs no change for #2.
- Per-defect file:line citations in the plan were produced by sub-agents against CURRENT code this session; treat as verified but re-confirm at execution time (memory/citations can drift).

## 6. Open questions the user deferred
- Whether/when to implement the two [contract] items (#3.4 designation-not-persisted; #5.3 atomic swap tool) — plan restates them as "surface to Derek separately", not resolved.
- TestFlight timing for the iOS wave (#1) — governed by the standing auto-push-at-end-of-work policy + the known stale-test gate; not decided in-session.
- No decision taken on the out-of-scope `field_matched ze 0.30` stale-echo (#6 in plan) beyond "separate triage".
