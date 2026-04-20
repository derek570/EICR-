#!/usr/bin/env bash
#
# Bootstrap script: wire the tracked .githooks/ into this clone.
#
# Run once per clone / per machine (e.g., on the Mac mini):
#
#     ./.githooks/install.sh
#
# What it does
# ------------
# - Points Git at the tracked .githooks/ directory so pre-push (and any
#   future hooks) run automatically. Git does not propagate .git/hooks/
#   on clone; this indirection via core.hooksPath is how tracked hooks
#   are adopted.
# - Sets pull.rebase=true so `git pull` replays local commits on top of
#   remote rather than creating merge bubbles — the 2026-04-10 divergence
#   incident would have surfaced sooner with linear history enforced.
#
# Why a script instead of a one-liner
# -----------------------------------
# So there's a single, version-controlled source of truth for what the
# repo expects. When we tighten the config further, we update this file
# and anyone can re-run it.
#
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if [ ! -d ".githooks" ]; then
    echo "Error: .githooks/ not found at repo root ($REPO_ROOT)." >&2
    exit 1
fi

# Make sure every tracked hook file is executable on this machine.
# Git does preserve the x-bit, but freshly-copied files on other
# filesystems can lose it — this is idempotent and cheap.
chmod +x .githooks/* 2>/dev/null || true

git config --local core.hooksPath .githooks
git config --local pull.rebase true

echo "Installed tracked hooks for this clone:"
echo "  core.hooksPath = $(git config --local --get core.hooksPath)"
echo "  pull.rebase    = $(git config --local --get pull.rebase)"
echo
echo "Active hooks:"
ls -1 .githooks/ | grep -vE '^(install\.sh|README\.md)$' | sed 's/^/  /'
