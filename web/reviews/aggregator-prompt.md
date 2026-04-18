# Aggregator prompt (used when both review streams complete)

You are consolidating findings from a two-reviewer, per-phase audit of a Next.js 16 / React 19 PWA frontend rebuild (EICR/EIC electrical-certificate tool).

For every phase `{id}` in `web/reviews/phases.tsv`, two reviews exist:
  - `web/reviews/claude/phase-{id}.md` — Claude subagent's review
  - `web/reviews/codex/phase-{id}.md` — Codex CLI's review

Both reviews share a 10-section structure (Summary, Alignment, Correctness P0/P1/P2, Security, Performance, Accessibility, Code quality, Test coverage, Suggested fixes, Verdict + top 3).

Your job:

1. For EACH phase, read BOTH reviews. Note where they AGREE (high confidence) vs DISAGREE (needs adjudication).
2. Produce a consolidated per-phase summary in `web/reviews/consolidated/phase-{id}.md` with sections:
   - Agreed findings (bulleted, severity-tagged)
   - Disagreements — side-by-side, with your adjudication and reasoning
   - Unique findings from Claude only
   - Unique findings from Codex only
   - Net verdict
3. Produce the master `web/reviews/FIX_PLAN.md` with:
   a. **Executive summary** (1 paragraph): overall health of the web rebuild, top systemic themes (e.g. "RBAC only enforced client-side across 6b/6c", "memory leaks on unmount pattern in 4b/4c").
   b. **Kill list** (P0 items that must land before any further phase): numbered, file:line, one-line why, estimated complexity (S/M/L).
   c. **Phase-by-phase fix table** (one row per finding): phase, severity (P0/P1/P2), area (correctness/security/perf/a11y/quality/test), file:line, fix summary, estimated complexity, depends-on.
   d. **Systemic / cross-cutting fixes** (bucketed): e.g. "audit trail missing", "all forms need inline validation", "bundle splitting", "prefers-reduced-motion sweep".
   e. **Test plan** (what to add): unit / integration / e2e coverage by phase.
   f. **Recommended sequencing** (phases 1-5 of fix work — what to ship together, what to leave for later). Be opinionated.
   g. **Open questions for the lead** (what needs a judgment call from a human).

Ground rules:
- Cite file:line for every finding. If a reviewer didn't cite a line, try to resolve it from the repo before dropping it.
- Downgrade findings that are obviously wrong (e.g. reviewer flagged code that a later phase already fixed — note the SHA that fixed it).
- Do NOT propose new features or refactors beyond what either reviewer called out.
- Keep the plan pragmatic: the lead is a single inspector-turned-developer shipping to TestFlight + production. Optimise for reality, not perfection.
- Do NOT modify any source files. This is plan-writing only. Only write files in `web/reviews/consolidated/` and `web/reviews/FIX_PLAN.md`.

When done, respond with a one-line confirmation and a bullet summary of (total P0s, total P1s, total P2s, total open questions).
