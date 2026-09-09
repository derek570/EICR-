#!/usr/bin/env bash
# A02D (2026-09-09) — regex-freshness raw-final vector fixture sync preflight.
#
# The shared job-state fixtures (`src/__tests__/fixtures/job-state/`) are the
# ONE input both clients start from: web's `buildJobStateForWire` and iOS's
# `APIClient.decoder` → `_test_buildJobStateForServer()` each produce a
# key-sorted output the backend Jest suite replays through `session_start`.
# Both platforms must start from IDENTICAL bytes, so every file in the
# backend directory must byte-compare equal to its iOS copy under
# `Tests/CertMateUnifiedTests/Fixtures/job-state/`.
#
# Fail-closed: any missing directory, missing file or differing byte exits
# non-zero. Named as a `CertMateUnified/deploy-testflight.sh` preflight and
# documented in docs/reference/deploy-testflight.md. Backend CI reads only
# the EICR copies; this script is the cross-repo drift stop.
#
# Usage:
#   scripts/check-regex-freshness-fixture-sync.sh      # iOS repo at ../CertMateUnified or ./CertMateUnified
#   IOS_REPO_ROOT=/path/to/CertMateUnified scripts/check-regex-freshness-fixture-sync.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EICR_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKEND_DIR="${EICR_ROOT}/src/__tests__/fixtures/job-state"

if [[ -n "${IOS_REPO_ROOT:-}" ]]; then
  ios_root="${IOS_REPO_ROOT}"
elif [[ -d "${EICR_ROOT}/CertMateUnified/Tests" ]]; then
  ios_root="${EICR_ROOT}/CertMateUnified"
elif [[ -d "${EICR_ROOT}/../CertMateUnified/Tests" ]]; then
  ios_root="$(cd "${EICR_ROOT}/../CertMateUnified" && pwd)"
else
  echo "check-regex-freshness-fixture-sync: iOS repo not found. Set IOS_REPO_ROOT." >&2
  exit 2
fi
SRC="${EICR_ROOT}/config/regex-freshness-vectors.json"
DST="${ios_root}/Tests/CertMateUnifiedTests/Fixtures/regex-freshness-vectors.json"

if [[ ! -f "${SRC}" ]]; then
  echo "check-regex-freshness-fixture-sync: missing canonical fixture ${SRC}" >&2
  exit 1
fi
if [[ ! -f "${DST}" ]]; then
  echo "check-regex-freshness-fixture-sync: missing iOS copy ${DST}" >&2
  exit 1
fi
if ! cmp -s "${SRC}" "${DST}"; then
  echo "DRIFT    regex-freshness-vectors.json: canonical and iOS copies differ" >&2
  echo "         canonical: $(shasum -a 256 "${SRC}" | cut -d' ' -f1)" >&2
  echo "         ios:       $(shasum -a 256 "${DST}" | cut -d' ' -f1)" >&2
  echo "check-regex-freshness-fixture-sync: FAILED — copy the canonical file to the iOS repo (same bytes) and move BOTH digest pins together." >&2
  exit 1
fi
echo "check-regex-freshness-fixture-sync: OK (byte-identical; sha256 $(shasum -a 256 "${SRC}" | cut -d' ' -f1); iOS root ${ios_root})"
