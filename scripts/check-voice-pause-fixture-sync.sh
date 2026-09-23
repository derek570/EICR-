#!/usr/bin/env bash
# PLAN-D (feedback wave 2026-09-17) — cross-repo voice-pause fixture byte-compare.
#
# config/voice-pause-vectors.json is the cross-platform contract for the
# hands-free voice pause: the command grammar, the accept and near-miss
# vectors, the five spoken strings and the resume tone's parameters. Both
# clients compile the strings into production constants and each client's
# test suite pins those constants against its copy of this fixture. The iOS
# repo carries a byte-identical COPY (XCTest targets cannot read outside
# their repo). THIS script is the cross-repo guard: a literal byte-compare of
# the two files, run as a NAMED pre-TestFlight step (see
# docs/reference/deploy-testflight.md) and runnable any time by hand.
#
# Sibling of check-poor-signal-fixture-sync.sh — same mechanism, same
# reasoning, different contract.
#
# Exit 0: files byte-identical. Exit 1: drift or a missing file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EICR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CANONICAL="$EICR_ROOT/config/voice-pause-vectors.json"
# The iOS checkout is nested inside the EICR working copy by convention;
# IOS_REPO_ROOT overrides for non-standard layouts (CI, worktrees).
IOS_COPY="${IOS_REPO_ROOT:-$EICR_ROOT/CertMateUnified}/Tests/CertMateUnifiedTests/Fixtures/voice-pause-vectors.json"

fail() {
  echo "voice-pause-fixture-sync: FAIL — $1" >&2
  exit 1
}

[ -f "$CANONICAL" ] || fail "canonical fixture missing at $CANONICAL"
[ -f "$IOS_COPY" ] || fail "iOS copy missing at $IOS_COPY (set IOS_REPO_ROOT if the checkout lives elsewhere)"

if cmp -s "$CANONICAL" "$IOS_COPY"; then
  echo "voice-pause-fixture-sync: OK — iOS copy byte-identical to canonical ($(shasum -a 256 "$CANONICAL" | cut -d' ' -f1))"
else
  echo "canonical: $(shasum -a 256 "$CANONICAL")" >&2
  echo "iOS copy:  $(shasum -a 256 "$IOS_COPY")" >&2
  fail "fixture drift — the two repos disagree; re-copy the canonical file and keep both clients' constants in step"
fi
