#!/usr/bin/env bash
# PLAN-C2 (feedback-2026-09-17 wave, Decision 6) — cross-repo OCPD TYPE manifest
# byte-compare.
#
# `config/ocpd-type-suggestions.json` is the NORMATIVE source for the
# `ocpd_type` canonicalisation grammar, the compatibility table behind the
# advisory, the BS 1361 display alias and the local-command sentences. Three
# twins consume it — the TS twin (packages/shared-utils/src/ocpd-type.ts), the
# backend twin (src/extraction/dialogue-engine/parsers/mcb-type.js) and the
# Swift twin (CertMateUnified Sources/Utilities/OcpdType.swift) — and each has
# its own conformance suite comparing returned BYTES for every vector.
#
# Those suites prove the PARSERS agree. They do not prove the two repos hold the
# same fixture: XCTest cannot read outside its repo, so iOS carries a COPY.
# Paired SHA-256 digest assertions catch a one-sided edit, but not a repo that
# changes both its fixture and its own digest constant. THIS script is that
# cross-repo guard, run as a NAMED hard-fail pre-TestFlight step (see
# docs/reference/deploy-testflight.md) and runnable by hand any time.
#
# There is no generated web module to compare: web compiles the list in through
# the TS twin, whose own test re-reads this file and asserts equality.
#
# Exit 0: the canonical file and the iOS copy agree.
# Exit 1: drift or a missing file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EICR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CANONICAL="$EICR_ROOT/config/ocpd-type-suggestions.json"
# The iOS checkout is nested inside the EICR working copy by convention;
# IOS_REPO_ROOT overrides for non-standard layouts (CI, worktrees).
IOS_COPY="${IOS_REPO_ROOT:-$EICR_ROOT/CertMateUnified}/Tests/CertMateUnifiedTests/Fixtures/ocpd-type-suggestions.json"

fail() {
  echo "ocpd-type-fixture-sync: FAIL — $1" >&2
  exit 1
}

[ -f "$CANONICAL" ] || fail "canonical manifest missing at $CANONICAL"
[ -f "$IOS_COPY" ] || fail "iOS copy missing at $IOS_COPY (set IOS_REPO_ROOT if the checkout lives elsewhere)"

if ! cmp -s "$CANONICAL" "$IOS_COPY"; then
  echo "canonical: $(shasum -a 256 "$CANONICAL")" >&2
  echo "iOS copy:  $(shasum -a 256 "$IOS_COPY")" >&2
  fail "manifest drift — the two repos disagree; re-copy the canonical file and update BOTH digest constants together"
fi

echo "ocpd-type-fixture-sync: OK — the iOS copy tracks the canonical ($(shasum -a 256 "$CANONICAL" | cut -d' ' -f1))"
