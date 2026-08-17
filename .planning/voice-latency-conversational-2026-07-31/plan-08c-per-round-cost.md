# Plan 08C — Per-round cost levers (pointer stub)

Status: **SUPERSEDED 2026-08-11 — split into two chunks at the `/rp` round-1 walkthrough
(Derek, Option A).** This combined document is no longer maintained; both halves converged
(round 9, both reviewers clean) and are the canonical references going forward:

- **[08C-A — per-round cost levers](plan-08c-a-per-round-cost.md)** — config-lever probes
  (§1.1 reasoning effort, §1.2 round-1 model) + the §1.4/§2.1 prefix/snapshot pair. Ships
  first via the chained `/ep` run. **SHIPPED 2026-08-17 (PR #189): NO ARM WINS — keep `recent_3`;
  benchmark harness + operator tooling delivered dark. See `docs/reference/changelog.md`.**
- **[08C-B — terminal-round shrink/eliminate lever](plan-08c-b-terminal-round.md)** — the
  08D-inherited terminal-round mechanism, its replication gate, and the four acceptance
  preconditions. Chains second, re-baselining against post-08C-A numbers.

The `/rp-opening gate` (independent CloudWatch confirmation of session `8B9B2BDD`, run on
`eicr-backend:392`) was discharged before the split and applies to both children; see either
child's Status section for the full timeline. Handoff folder for the refine history:
`~/.claude/handoffs/EICR_Automation--08c-per-round-cost-2026-08-11/`.

Do not edit this stub with new plan content — edit the owning child instead.
