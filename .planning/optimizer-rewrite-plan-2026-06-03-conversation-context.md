# Conversation context for /rp — optimizer-rewrite-plan-2026-06-03

## Source

Substantive prior conversation. The session ran the plan author (Claude) through: (a) deploying yesterday's IR L-L=2 fix to production, (b) analysing the optimizer's last 30 days of output, (c) reading the optimizer's source + prompt + categories to identify drift, then (d) drafting and decision-locking this plan. Sections 2–6 below summarise the load-bearing decisions / constraints / gotchas / rejected alternatives from that flow.

## Decisions the user explicitly made

- **Per-signature `auto_pr` flag, not a global toggle.** When asked whether signature-matched recommendations should auto-PR or stay report-only, Derek said "Keep [human] in the loop currently, but make it so there can be a switch once we have confidence". My follow-up encoded this as per-signature, defaulting `false` on every entry — not a global on/off — so individual signatures can be promoted independently once they earn confidence.
- **Option B for auto-generated probes (sibling directory).** Derek said "option B sounds safer and better long-term, do you agree?" — I agreed. Auto-generated probes write to `tests/fixtures/voice-latency-scenarios/auto-generated/<suite>/`, NOT the main directory. Promotion via manual `mv` after replay verification.
- **Pushover stays per-session for now; build batching mode behind a flag.** Derek said "keep it [as is]… it's only me testing, but have a button to batch later when we get more testers". Encoded as `NOTIFY_MODE` config flag defaulting `per_session`; batch mode skeleton lands in Cluster 3 alongside the probe generator but stays dormant until activated.
- **The optimizer rewrite is in scope; the iOS/backend per-slot Flux Configure implementation is NOT.** Derek explicitly framed this plan as "the optimizer side". I held the line that recommending the fix shape is in scope; building the actual iOS Configure-message infrastructure is a separate sprint.
- **The 8 items organise into 3 clusters with Cluster 3 being the keyterm/signature/probe work.** Derek's phrasing was "cluster three, hence Key term improvements" — read as making Cluster 3 the per-slot keyterm + signature + probe work (which is where the actionable keyterm improvements would live in this plan's frame).

## Constraints surfaced

- **Optimizer is a Mac-local LaunchAgent**, not a deployed service. No backend deploy needed for shell-script or `analyze-session.js` changes — picks up on next 120s poll. LaunchAgent plist itself requires `launchctl unload/load` if changed.
- **Backend `src/`, `config/prompts/`, `packages/shared-types`, `packages/shared-utils` are IMMUTABLE during PWA-only work** (project CLAUDE.md rule — shared with iOS). This plan is optimizer-side only, but any execution that drifts into backend changes needs to flag iOS shared-contract risk.
- **The main probe suite must stay trustworthy as the regression bed.** This was the explicit reason for picking Option B over Option A in question 2.
- **Plan changes must not lose HIL (human-in-the-loop) for new bug classes.** Auto-PR exists as a future-state opt-in per signature, never as a default for unverified classes.
- **Total budget ~5–7 days across 3 PRs, landed independently.** No single mega-PR; each cluster is its own deployable unit.
- **Flux's `:boost` suffix is dead.** Any prompt language that frames `keyword_boost` as acoustic-bias is misleading and must be rewritten to reflect inclusion-priority-only semantics on Flux.

## Alternatives considered and rejected

- **Reverting to Deepgram Nova-3** — rejected. Derek's own observation: "I think with loaded barrel Nova would cause chaos as it would send half sentences far too often." Nova was better at vocabulary recall, worse at endpointing; Loaded Barrel depends on Flux's turn detection. The keyterm-improvement work in this plan is about making Flux better for our vocabulary, NOT about migrating off Flux.
- **Going back to Sonnet from Haiku** — rejected. I initially mis-described Haiku as slower; corrected to "Haiku is ~1.5–2× faster than Sonnet" — switching back would worsen the 5–7s perceived latency, not improve it.
- **Global "auto-PR on" toggle for signature recommendations** — rejected (question 1). All-or-nothing is too risky; per-signature is the chosen granularity.
- **Auto-generated probes living in the main `tests/fixtures/` directory with an `auto_generated: true` flag (Option A)** — rejected (question 2). Risk of a falsely-detected bug class silently masking a real regression in CI was the load-bearing concern.
- **Bumping `keyword_boost` from 1.5 → 2.5** for problem terms (the optimizer's own past recommendations) — rejected by analysis. Flux ignores the boost suffix, so the lift is purely noise; only inclusion-priority survives the URL truncation.
- **Letting the optimizer touch backend or iOS source files directly** — rejected by the existing optimizer architecture itself ("plan-only mode" per the v4 comment block) and re-affirmed by Derek's HIL constraint. The plan must preserve "optimizer never edits source".

## Gotchas / hidden requirements

- **Optimizer state file at `~/.certmate/optimizer_state.json`** (currently ~130 KB; backup from April was 17 KB — state growth from harness sessions polluting the queue). Item 1 implementation needs a state-file cleanup pass alongside the poll filter.
- **`session-optimizer.sh.stale.bak` from 9 April** exists in `~/.certmate/` — evidence of prior cleanup attempts that didn't fully land.
- **Plan file lives at `.planning/optimizer-rewrite-plan-2026-06-03.md`**, untracked on `main`. PR #41 (which carried this plan) was closed without merging; the file is currently working-tree-only.
- **Optimizer prompt template is at `scripts/optimizer-prompt-session.md`** — that's the actual file Cluster 1 Items 2 + 3 edit, not the shell script.
- **Optimizer categories appear in THREE files** (prompt, `generate-report-html.js`, and a switch in `session-optimizer.sh` around line 1304). Adding a category needs all three edits in lockstep.
- **`render-prompt.cjs`** is the templating layer the shell script invokes — the template variables documented in Cluster 2 Item 6 must align with what `render-prompt.cjs` knows how to inject.
- **Flux Configure messages already plumbed in `DeepgramService.swift` lines 100–138** — Cluster 3's per-slot keyterm recommendation depends on this existing plumbing being correct.
- **`focused_mode_enter` / `focused_mode_enter_result` / `focused_mode_exit` events are already logged** by iOS — Cluster 2 Item 6's `focused_mode_timeline` extraction is a parse-existing-logs job, not a new-instrumentation job.
- **`KNOWN_FIELDS` lives in `sonnet-stream.js`; `FIELD_CORRECTIONS` lives in `field-name-corrections.js`** — the `field_name_correction_add` category recommendation needs to know both files and which entry to add to which.
- **iOS dual-alias decoders accept both canonical and legacy field names** for IR / ring / Zs / cable fields — recently confirmed during the audit phase 3 work. Affects how `field_name_correction_add` is scoped: not every canonical-name leak is a user-facing bug.
- **Yesterday's L-L=2 fix is the canonical reference example** for the `dialogue_engine_schema_tighten` category (commit `3c77b1bb`). The plan literally cites this commit as the `reference_commit` field on the `ir_bare_bridge_single_digit` signature.
- **`scripts/__tests__/analyze-session.test.mjs` exists** as the regression bed for Cluster 2 Item 6's parser extensions.
- **Cluster 3 Item 8 needs a new `scripts/probe-templates/` directory** — currently doesn't exist. Plan should specify whether this is the right location or whether templates live alongside their detector code in `analyze-session.js`.

## Open questions the user deferred

- **None explicitly carried forward.** Three open questions raised during plan review were all locked during the same session (the "Decisions (locked 2026-06-03)" section). No "we'll decide when we get there" items remain.
