#!/usr/bin/env bash
#
# sync-local-main.sh — keep local `main` in sync with `origin/main`.
#
# WHY THIS EXISTS:
#   Backend (and iOS) ship via remote PR merge → CI → ECS/TestFlight. That
#   path never touches the developer Mac's working copy, so `origin/main`
#   advances (every merged /ep wave) while local `main` stays frozen at the
#   last commit made/pulled on the Mac. The drift is invisible until a local
#   investigation/edit silently happens against dead code (this bit us:
#   local was 50 commits behind on 2026-06-23 — see the field-feedback
#   handoff). This script self-heals that at the start of every Claude
#   session via a SessionStart hook (wired in .claude/settings.local.json).
#
# SAFETY: only ever fast-forwards, and ONLY when the repo is on `main` with a
#   clean working tree (untracked files are ignored — the repo routinely
#   carries untracked .planning-stage6-agentic/ handoffs). Never rebases,
#   never touches a feature branch, never discards work. Always exits 0 so a
#   network hiccup can't block a session.
#
# USAGE: sync-local-main.sh [repo_path ...]
#   With no args, syncs the two EICR repos (backend + iOS).

set -u

REPOS=("$@")
if [ ${#REPOS[@]} -eq 0 ]; then
  REPOS=(
    "/Users/derekbeckley/Developer/EICR_Automation"
    "/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified"
  )
fi

for repo in "${REPOS[@]}"; do
  [ -d "$repo/.git" ] || { echo "[sync-main] $repo: not a git repo, skip"; continue; }
  name=$(basename "$repo")

  branch=$(git -C "$repo" symbolic-ref --short -q HEAD || echo "DETACHED")
  if [ "$branch" != "main" ]; then
    echo "[sync-main] $name: on '$branch' (not main) — skip"
    continue
  fi

  # Dirty = staged or unstaged tracked changes. Untracked files don't count.
  if ! git -C "$repo" diff --quiet || ! git -C "$repo" diff --cached --quiet; then
    echo "[sync-main] $name: working tree dirty — skip (pull manually when ready)"
    continue
  fi

  if ! git -C "$repo" fetch origin main --quiet 2>/dev/null; then
    echo "[sync-main] $name: fetch failed (offline?) — skip"
    continue
  fi

  behind=$(git -C "$repo" rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
  if [ "$behind" -eq 0 ]; then
    echo "[sync-main] $name: up to date"
    continue
  fi

  if git -C "$repo" merge --ff-only origin/main --quiet 2>/dev/null; then
    echo "[sync-main] $name: fast-forwarded $behind commit(s) → $(git -C "$repo" rev-parse --short HEAD)"
  else
    echo "[sync-main] $name: $behind behind but NOT fast-forwardable (local commits diverged) — resolve manually"
  fi
done

exit 0
