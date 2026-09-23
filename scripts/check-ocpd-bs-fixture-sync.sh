#!/usr/bin/env bash
# PLAN-CC (feedback-2026-09-17 wave) — cross-repo OCPD BS(EN) manifest byte-compare.
#
# `config/ocpd-bs-suggestions.json` is the NORMATIVE source for the
# `ocpd_bs_en` canonicalisation alias table and the picker's two suggestion
# tiers. Three producers consume it — the web TS twin, the Swift twin, and
# (PLAN-CS) the backend `parseOcpdStandard` — and each has its own conformance
# test driving every vector and comparing returned BYTES.
#
# Those output tests prove the PARSERS agree. They do NOT prove the two repos
# hold the same fixture: XCTest targets cannot read outside their repo, so the
# iOS side carries a byte-identical COPY. Paired SHA-256 digest assertions in
# both suites catch a single-side fixture edit, but NOT a repo changing both
# its fixture and its own digest constant. THIS script is that cross-repo
# guard, run as a NAMED hard-fail pre-TestFlight step (see
# docs/reference/deploy-testflight.md) and runnable any time by hand.
#
# It also byte-compares the GENERATED web module, because that module — not the
# JSON — is what the production web bundle actually compiles against. The
# builder stage of docker/nextjs.Dockerfile never copies root `config/`, so a
# hand-edited generated module would ship bytes no fixture and no digest test
# would ever see. Regenerating to a temp path and comparing closes that.
#
# Sibling of check-closed-enum-fixture-sync.sh — same mechanism, same
# reasoning, different contract.
#
# Exit 0: canonical, iOS copy and generated module all agree.
# Exit 1: drift, a missing file, or a generator failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EICR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CANONICAL="$EICR_ROOT/config/ocpd-bs-suggestions.json"
GENERATOR="$EICR_ROOT/scripts/generate-ocpd-bs-suggestions.mjs"
GENERATED="$EICR_ROOT/web/src/lib/recording/ocpd-bs-suggestions.generated.ts"
# The iOS checkout is nested inside the EICR working copy by convention;
# IOS_REPO_ROOT overrides for non-standard layouts (CI, worktrees).
IOS_COPY="${IOS_REPO_ROOT:-$EICR_ROOT/CertMateUnified}/Tests/CertMateUnifiedTests/Fixtures/ocpd-bs-suggestions.json"

TMP_GENERATED=""
cleanup() { [ -n "$TMP_GENERATED" ] && rm -f "$TMP_GENERATED"; }
trap cleanup EXIT

fail() {
  echo "ocpd-bs-fixture-sync: FAIL — $1" >&2
  exit 1
}

[ -f "$CANONICAL" ] || fail "canonical manifest missing at $CANONICAL"
[ -f "$GENERATOR" ] || fail "generator missing at $GENERATOR"
[ -f "$GENERATED" ] || fail "generated web module missing at $GENERATED (run: node scripts/generate-ocpd-bs-suggestions.mjs)"
[ -f "$IOS_COPY" ] || fail "iOS copy missing at $IOS_COPY (set IOS_REPO_ROOT if the checkout lives elsewhere)"

# 1. Canonical vs the iOS copy.
if ! cmp -s "$CANONICAL" "$IOS_COPY"; then
  echo "canonical: $(shasum -a 256 "$CANONICAL")" >&2
  echo "iOS copy:  $(shasum -a 256 "$IOS_COPY")" >&2
  fail "manifest drift — the two repos disagree; re-copy the canonical file and update BOTH digest constants together"
fi

# 2. Canonical vs the committed generated web module.
TMP_GENERATED="$(mktemp -t ocpd-bs-suggestions-generated.XXXXXX)"
if ! node "$GENERATOR" --out "$TMP_GENERATED" >/dev/null; then
  fail "generator failed — cannot verify the committed web module"
fi
if ! cmp -s "$TMP_GENERATED" "$GENERATED"; then
  echo "committed:   $(shasum -a 256 "$GENERATED")" >&2
  echo "regenerated: $(shasum -a 256 "$TMP_GENERATED")" >&2
  fail "generated web module is stale or hand-edited — run: node scripts/generate-ocpd-bs-suggestions.mjs"
fi

echo "ocpd-bs-fixture-sync: OK — iOS copy and generated web module both track the canonical ($(shasum -a 256 "$CANONICAL" | cut -d' ' -f1))"
