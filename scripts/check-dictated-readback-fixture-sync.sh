#!/usr/bin/env bash
# A04P — fail closed when the canonical dictated-readback policy and the
# separately shipped XCTest copy differ by even one byte.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EICR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CANONICAL="$EICR_ROOT/config/dictated-readback-policy-v1.json"
IOS_COPY="${IOS_REPO_ROOT:-$EICR_ROOT/CertMateUnified}/Tests/CertMateUnifiedTests/Fixtures/dictated-readback-policy-v1.json"

fail() {
  echo "dictated-readback-fixture-sync: FAIL — $1" >&2
  exit 1
}

[ -f "$CANONICAL" ] || fail "canonical policy missing at $CANONICAL"
[ -f "$IOS_COPY" ] || fail "iOS copy missing at $IOS_COPY (set IOS_REPO_ROOT for a separate worktree)"

if cmp -s "$CANONICAL" "$IOS_COPY"; then
  echo "dictated-readback-fixture-sync: OK — byte-identical ($(shasum -a 256 "$CANONICAL" | cut -d' ' -f1))"
else
  echo "canonical: $(shasum -a 256 "$CANONICAL")" >&2
  echo "iOS copy:  $(shasum -a 256 "$IOS_COPY")" >&2
  fail "policy drift — re-copy the canonical bytes and update all digest pins together"
fi
