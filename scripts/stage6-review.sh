#!/usr/bin/env bash
# scripts/stage6-review.sh
# -----------------------------------------------------------------------------
# Stage 6 Agentic — per-phase dual-reviewer gate (Codex half).
#
# The Stage 6 milestone (see .planning-stage6-agentic/ROADMAP.md §"Global
# phase rule — dual-reviewer gate (STG)") requires that every phase closes
# with a REVIEW.md signed by both Claude and Codex. This script is the Codex
# half: it bundles the milestone goal (PROJECT.md), the requirements
# (REQUIREMENTS.md), the phase's PLAN(s), and the git diff of the phase's
# work against the base branch, and pipes the bundle into `codex exec` in
# read-only sandbox mode.
#
# Output on stdout is the Codex review transcript, ready to paste into
# `phases/NN-name/REVIEW.md` under a "## Codex Review" heading. Progress
# messages go to stderr.
#
# If `codex` is not on PATH, the script falls back to preserving the bundle
# in a `.kept` tempfile and printing manual-invocation instructions to
# stderr — the Phase 1 review can still close with a hand-driven Codex
# session.
#
# Frozen invocation (verified 2026-04-21 against codex-cli 0.116.0):
#   codex exec -s read-only --skip-git-repo-check -
# See scripts/README-stage6-review.md for the rationale + dry-run evidence.
#
# Usage:
#   ./scripts/stage6-review.sh <phase-dir>
# Example:
#   ./scripts/stage6-review.sh \
#     /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/.planning-stage6-agentic/phases/01-foundation
#
# Env vars:
#   STAGE6_BASE_BRANCH (default: main) — git ref the diff is taken against.
#   PLANNING_TREE      (default: <backend-repo>/../CertMateUnified/.planning-stage6-agentic)
#                      — path to the planning tree containing PROJECT.md etc.
#   STAGE6_SKIP_CODEX  (default: unset) — if set to any value, force the
#                      manual-fallback path even when codex is on PATH.
#                      Used by the smoke test in scripts/__tests__.
#
# Exit codes:
#   0  Review ran (or fell back to manual-mode output).
#   2  <phase-dir> missing or not a directory.
#   3  Required planning artefact (PROJECT.md / REQUIREMENTS.md) missing.
#   *  Codex itself exited non-zero — stderr carries its output.
# -----------------------------------------------------------------------------
set -euo pipefail

# --- args --------------------------------------------------------------------
PHASE_DIR="${1:-}"
if [[ -z "$PHASE_DIR" ]]; then
  echo "usage: $0 <phase-dir>" >&2
  echo "example: $0 .../CertMateUnified/.planning-stage6-agentic/phases/01-foundation" >&2
  exit 2
fi
if [[ ! -d "$PHASE_DIR" ]]; then
  echo "[stage6-review] not a directory: $PHASE_DIR" >&2
  exit 2
fi

# Normalize to absolute path — the bundle includes the path as provenance.
PHASE_DIR="$(cd "$PHASE_DIR" && pwd)"

# --- config ------------------------------------------------------------------
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
BASE_BRANCH="${STAGE6_BASE_BRANCH:-main}"

# PLANNING_TREE default: the iOS app lives as a subdirectory of the backend
# repo (CertMateUnified/ has its own git repo nested inside EICR_Automation/),
# and the Stage 6 planning tree lives inside the iOS repo at
# CertMateUnified/.planning-stage6-agentic/. If this script is run from the
# backend repo root, the default below resolves it correctly. If run from
# somewhere else, the caller sets PLANNING_TREE explicitly.
DEFAULT_PLANNING_TREE="$PROJECT_ROOT/CertMateUnified/.planning-stage6-agentic"
if [[ ! -d "$DEFAULT_PLANNING_TREE" ]]; then
  # Fallback: maybe we're already inside the iOS repo, so PROJECT_ROOT
  # itself points there.
  if [[ -d "$PROJECT_ROOT/.planning-stage6-agentic" ]]; then
    DEFAULT_PLANNING_TREE="$PROJECT_ROOT/.planning-stage6-agentic"
  fi
fi
PLANNING_TREE="${PLANNING_TREE:-$DEFAULT_PLANNING_TREE}"

# Resolve to absolute path if it exists (allows the caller to pass a
# relative path too).
if [[ -d "$PLANNING_TREE" ]]; then
  PLANNING_TREE="$(cd "$PLANNING_TREE" && pwd)"
fi

if [[ ! -f "$PLANNING_TREE/PROJECT.md" ]] || [[ ! -f "$PLANNING_TREE/REQUIREMENTS.md" ]]; then
  echo "[stage6-review] missing PROJECT.md or REQUIREMENTS.md under $PLANNING_TREE" >&2
  echo "[stage6-review] set PLANNING_TREE env var to the correct planning directory." >&2
  exit 3
fi

# --- bundle ------------------------------------------------------------------
# mktemp portability: BSD mktemp (macOS) requires the X's at the end of the
# template; -t prefixes with $TMPDIR. This form works on both macOS and GNU.
BUNDLE="$(mktemp -t stage6-review.XXXXXX)"
# The `.md` extension isn't required by codex — it reads raw text from stdin —
# but preserving the bundle in the fallback path is nicer as a .md file.
BUNDLE_MD="${BUNDLE}.md"
mv "$BUNDLE" "$BUNDLE_MD"
BUNDLE="$BUNDLE_MD"

# Clean up on normal exit. Fallback path disables the trap before it exits.
trap 'rm -f "$BUNDLE"' EXIT

{
  cat <<'PROMPT'
# Stage 6 Agentic — Phase Review Request

You are a second-opinion code reviewer. The bundle below contains the
milestone goal (PROJECT.md), the full requirements (REQUIREMENTS.md),
the phase's PLAN(s), and the git diff of the phase's work against the
base branch.

Produce findings in this structure, each on its own line:

- [BLOCK] <file:line> — <problem> — <suggested fix>
- [MAJOR] <file:line> — ...
- [MINOR] <file:line> — ...
- [NIT]   <file:line> — ...

Focus on: correctness, race conditions (especially streaming assembly
and any blocking flows), error handling, JSON-schema strictness, and
the prompt-injection surface on any user-routed strings. Ignore
style/formatting — that is handled by prettier/eslint and is not a
reviewer concern.

When in doubt, explain the scenario you are worried about rather than
asserting a bug. If a finding depends on a file we did not include,
list the file by path and name the hypothesis rather than guessing
its contents.

---
PROMPT

  echo ""
  echo "## Review provenance"
  echo ""
  echo "- Phase dir: \`$PHASE_DIR\`"
  echo "- Planning tree: \`$PLANNING_TREE\`"
  echo "- Project root: \`$PROJECT_ROOT\`"
  echo "- Base branch: \`$BASE_BRANCH\`"
  echo "- Current HEAD: \`$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || echo 'unknown')\`"
  echo "- Generated: \`$(date -u +"%Y-%m-%dT%H:%M:%SZ")\`"
  echo ""

  echo "## PROJECT.md"
  echo ""
  cat "$PLANNING_TREE/PROJECT.md"
  echo ""

  echo "## REQUIREMENTS.md"
  echo ""
  cat "$PLANNING_TREE/REQUIREMENTS.md"
  echo ""

  echo "## Phase PLAN(s)"
  echo ""
  # Glob may be empty if the dir has no *-PLAN.md files yet; use nullglob-ish
  # pattern via the for-loop guard to avoid matching the literal pattern.
  shopt -s nullglob
  found_plans=0
  for plan_file in "$PHASE_DIR"/*-PLAN.md; do
    echo "### $(basename "$plan_file")"
    echo ""
    cat "$plan_file"
    echo ""
    found_plans=$((found_plans + 1))
  done
  shopt -u nullglob
  if [[ "$found_plans" -eq 0 ]]; then
    echo "_No \`*-PLAN.md\` files found in $PHASE_DIR — this phase has no plan artefacts to bundle._"
    echo ""
  fi

  echo "## Phase diff against \`$BASE_BRANCH\`"
  echo ""
  if git -C "$PROJECT_ROOT" rev-parse --verify "$BASE_BRANCH" >/dev/null 2>&1; then
    echo '```'
    echo "# git diff $BASE_BRANCH --stat"
    git -C "$PROJECT_ROOT" diff "$BASE_BRANCH" --stat || true
    echo '```'
    echo ""
    echo '```diff'
    git -C "$PROJECT_ROOT" diff "$BASE_BRANCH" || true
    echo '```'
  else
    echo "_Base branch \`$BASE_BRANCH\` is not reachable from $PROJECT_ROOT._"
    echo "_Falling back to diff against the merge-base of the current branch._"
    echo ""
    echo '```diff'
    git -C "$PROJECT_ROOT" diff HEAD~5..HEAD 2>/dev/null || echo "(no recent diff available)"
    echo '```'
  fi
} > "$BUNDLE"

BUNDLE_BYTES="$(wc -c < "$BUNDLE" | tr -d ' ')"
echo "[stage6-review] bundle: $BUNDLE ($BUNDLE_BYTES bytes)" >&2

# --- invoke codex ------------------------------------------------------------
# If STAGE6_SKIP_CODEX is set OR codex is not on PATH, take the manual
# fallback. See scripts/README-stage6-review.md §"Manual fallback".
if [[ -n "${STAGE6_SKIP_CODEX:-}" ]] || ! command -v codex >/dev/null 2>&1; then
  if [[ -n "${STAGE6_SKIP_CODEX:-}" ]]; then
    echo "[stage6-review] STAGE6_SKIP_CODEX is set — forcing manual fallback." >&2
  else
    echo "[stage6-review] codex CLI not on PATH — falling back to manual mode." >&2
  fi
  KEPT="${BUNDLE}.kept"
  cp "$BUNDLE" "$KEPT"
  trap - EXIT  # preserve the .kept copy
  rm -f "$BUNDLE"
  echo "[stage6-review] Bundle preserved at: $KEPT" >&2
  echo "[stage6-review] To run the review manually:" >&2
  echo "  1. (install codex if needed)   brew install codex" >&2
  echo "  2. Pipe the bundle to codex:   cat \"$KEPT\" | codex exec -s read-only --skip-git-repo-check -" >&2
  echo "  3. Or paste the bundle into a Codex web-chat session." >&2
  echo "[stage6-review] Bundle body follows on stdout for direct capture into REVIEW.md:" >&2
  cat "$KEPT"
  exit 0
fi

echo "[stage6-review] invoking codex exec -s read-only --skip-git-repo-check -" >&2
# FROZEN INVOCATION — see scripts/README-stage6-review.md and
# .planning-stage6-agentic/phases/01-foundation/OPEN_QUESTIONS.md Q#1.
# DO NOT add --full-auto (grants workspace-write, wrong posture for a
# reviewer). DO NOT drop --skip-git-repo-check (tempfile stdin is not a
# git worktree). Change only with explicit STG sign-off.
cat "$BUNDLE" | codex exec -s read-only --skip-git-repo-check -
