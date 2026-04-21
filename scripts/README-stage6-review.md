# `stage6-review.sh` — Per-phase Codex review wrapper

Purpose: Second-opinion code reviewer for the **Stage 6 Agentic Extraction** milestone.
Every phase ends with a dual-reviewer gate (Claude + Codex) per
`.planning-stage6-agentic/ROADMAP.md` §"Global phase rule — dual-reviewer gate (STG)".
This script is the Codex half.

Claude's half is run inline by the GSD agent (`gsd-integration-checker` + targeted
`Read`/`Grep` against the phase plan + diff) and writes findings directly into
`phases/NN-name/REVIEW.md`. Codex's half is run here.

## Quick usage

```bash
# From either repo root; script finds its own project root via `git rev-parse`.
# PLANNING_TREE points at the .planning-stage6-agentic/ dir (lives in the iOS repo).

cd /Users/derekbeckley/Developer/EICR_Automation

PLANNING_TREE=/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/.planning-stage6-agentic \
  scripts/stage6-review.sh \
    "$PLANNING_TREE/phases/01-foundation"
```

Default `PLANNING_TREE` if unset: `../CertMateUnified/.planning-stage6-agentic`
relative to the backend repo root.

Output goes to **stdout** (the Codex review body — paste / redirect into REVIEW.md).
Progress messages go to **stderr**.

## Frozen Codex invocation

**Verified 2026-04-21** against `codex-cli 0.116.0` (installed at
`/opt/homebrew/bin/codex`):

```bash
codex exec -s read-only --skip-git-repo-check -
```

- `exec` — non-interactive mode (runs, answers, exits).
- `-s read-only` — sandbox policy that forbids any file writes or network egress
  beyond the model call. Mandatory for a review tool: Codex must never touch the
  tree it is reviewing.
- `--skip-git-repo-check` — required because stdin may be piped from outside a
  git worktree (the script builds the bundle in `$TMPDIR`) and Codex otherwise
  refuses to start when its `workdir` is not a repo. We already capture the diff
  against `main` inside the bundle, so Codex doesn't need git-repo semantics.
- `-` — read the prompt from stdin. The script pipes the bundle in.

**Dry-run evidence** (2026-04-21):

```
$ echo "Respond with exactly the three characters: OK!" | codex exec -s read-only --skip-git-repo-check -
OpenAI Codex v0.116.0 (research preview)
--------
workdir: .../CertMateUnified
model: gpt-5.4
provider: openai
approval: never
sandbox: read-only
--------
user
Respond with exactly the three characters: OK!

codex
OK!
tokens used
883
OK!
```

The invocation accepts stdin, obeys `read-only`, and emits the response under a
`codex` heading with token accounting at the bottom. The script captures
everything codex prints to stdout so `REVIEW.md` can quote the full transcript.

**Why NOT `codex review --base main`:** That subcommand is also available in
0.116.0 and would be a natural fit, but it (a) requires the working tree to be
a git repo (fine for us, but couples the tool to git) and (b) doesn't accept
the extra PROJECT.md + REQUIREMENTS.md + PLAN context we want bundled into the
prompt. `exec` with a hand-assembled bundle is a better fit for the STG
contract, which explicitly requires the reviewer to see
`PROJECT.md + REQUIREMENTS.md + PLAN + diff` together.

## Prompt boilerplate

The script prepends this to the bundle before piping to Codex:

```
# Stage 6 Agentic — Phase Review Request

You are a second-opinion code reviewer. The bundle below contains the
milestone goal (PROJECT.md), the full requirements (REQUIREMENTS.md), the
phase's PLAN(s), and the git diff of the phase's work against the base
branch.

Produce findings in this structure, each on its own line:

- [BLOCK] <file:line> — <problem> — <suggested fix>
- [MAJOR] <file:line> — ...
- [MINOR] <file:line> — ...
- [NIT]   <file:line> — ...

Focus on: correctness, race conditions (especially streaming assembly + any
blocking flows), error handling, JSON-schema strictness, prompt-injection
surface on user-routed strings. Ignore style/formatting (handled by
prettier/eslint).

When in doubt, explain the scenario you are worried about rather than
asserting a bug.
```

## Manual fallback (if script is unavailable or broken)

If `scripts/stage6-review.sh` is missing, broken, or `codex` is unavailable
at review time, run the review by hand:

1. `cd /Users/derekbeckley/Developer/EICR_Automation`
2. Build the bundle yourself:
   ```bash
   BUNDLE=/tmp/stage6-review-manual.md
   PLANNING=/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/.planning-stage6-agentic
   {
     cat <<'PROMPT'
   # Stage 6 Agentic — Phase Review Request
   (paste the boilerplate above here)
   ---
   PROMPT
     echo "## PROJECT.md"; cat "$PLANNING/PROJECT.md"
     echo "## REQUIREMENTS.md"; cat "$PLANNING/REQUIREMENTS.md"
     echo "## Phase PLAN(s)"
     for f in "$PLANNING/phases/01-foundation"/*-PLAN.md; do
       echo "### $(basename "$f")"; cat "$f"
     done
     echo "## Phase diff"; echo '```diff'
     git diff main --stat; echo; git diff main
     echo '```'
   } > "$BUNDLE"
   ```
3. Pipe it to Codex OR (if Codex is down) paste it into the Codex web chat /
   another reviewer LLM:
   ```bash
   cat "$BUNDLE" | codex exec -s read-only --skip-git-repo-check -
   ```
4. Capture the output into `phases/NN-name/REVIEW.md` under a `## Codex Review`
   heading; record the exact command used for reproducibility.

## Install

As of 2026-04-21 Codex CLI is already installed on Derek's Mac at
`/opt/homebrew/bin/codex` (version `0.116.0`). If missing, install with:

```bash
brew install codex
# or, if that fails:
npm install -g @openai/codex
```

Verify: `codex --version` should print `codex-cli 0.x.y`.

If `codex` cannot be installed (e.g. fresh VM, offline machine), the script
falls back automatically: it writes the bundle to a `.kept` file under
`$TMPDIR` and prints manual-invocation instructions to stderr. The Phase 1
review can still run with a hand-driven Codex web-chat session and the kept
bundle.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `STAGE6_BASE_BRANCH` | `main` | Git ref the phase diff is taken against. Override when reviewing a feature branch against a non-main base. |
| `PLANNING_TREE` | `$(git rev-parse --show-toplevel)/../CertMateUnified/.planning-stage6-agentic` | Path to the planning directory that holds `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `phases/`. Override if the planning tree moves. |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Review ran (or fell back to manual-mode bundle output). |
| 2 | `<phase-dir>` argument missing or not a directory. |
| 3 | Required planning artefact (PROJECT.md / REQUIREMENTS.md) missing. |
| other | Codex itself exited non-zero — stderr carries its output. |
