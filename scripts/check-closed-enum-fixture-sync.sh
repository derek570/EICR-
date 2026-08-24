#!/usr/bin/env bash
# PLAN-C (feedback id 129) — cross-repo closed-enum-vector fixture byte-compare.
#
# The golden-vector fixture config/closed-enum-vectors.json is the
# cross-platform contract for the closed-enum guard (web Vitest and iOS
# XCTest both assert against it, and it is derived from the option lists
# in config/field_schema.json). The iOS repo carries a byte-identical
# COPY (XCTest targets cannot read outside their repo); paired SHA-256
# digest assertions in both repos catch a single-side fixture edit, but
# NOT a repo changing both its fixture and its local constant. THIS
# script is that cross-repo guard: a literal byte-compare of the two
# files, run as a NAMED pre-TestFlight step (see
# docs/reference/deploy-testflight.md) and runnable any time by hand.
#
# Sibling of check-designation-fixture-sync.sh — same mechanism, same
# reasoning, different contract.
#
# Exit 0: files byte-identical. Exit 1: drift or a missing file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EICR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CANONICAL="$EICR_ROOT/config/closed-enum-vectors.json"
# The iOS checkout is nested inside the EICR working copy by convention;
# IOS_REPO_ROOT overrides for non-standard layouts (CI, worktrees).
IOS_COPY="${IOS_REPO_ROOT:-$EICR_ROOT/CertMateUnified}/Tests/CertMateUnifiedTests/Fixtures/closed-enum-vectors.json"

fail() {
  echo "closed-enum-fixture-sync: FAIL — $1" >&2
  exit 1
}

[ -f "$CANONICAL" ] || fail "canonical fixture missing at $CANONICAL"
[ -f "$IOS_COPY" ] || fail "iOS copy missing at $IOS_COPY (set IOS_REPO_ROOT if the checkout lives elsewhere)"

if cmp -s "$CANONICAL" "$IOS_COPY"; then
  echo "closed-enum-fixture-sync: OK — iOS copy byte-identical to canonical ($(shasum -a 256 "$CANONICAL" | cut -d' ' -f1))"
else
  echo "canonical: $(shasum -a 256 "$CANONICAL")" >&2
  echo "iOS copy:  $(shasum -a 256 "$IOS_COPY")" >&2
  fail "fixture drift — the two repos disagree; re-copy the canonical file and update BOTH digest constants together"
fi
