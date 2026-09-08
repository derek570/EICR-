#!/usr/bin/env bash
# A01P (2026-09-08) — job-state fixture sync preflight.
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
#   scripts/check-job-state-fixture-sync.sh            # iOS repo at ../CertMateUnified or ./CertMateUnified
#   IOS_REPO_ROOT=/path/to/CertMateUnified scripts/check-job-state-fixture-sync.sh
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
  echo "check-job-state-fixture-sync: iOS repo not found. Set IOS_REPO_ROOT." >&2
  exit 2
fi
IOS_DIR="${ios_root}/Tests/CertMateUnifiedTests/Fixtures/job-state"

if [[ ! -d "${BACKEND_DIR}" ]]; then
  echo "check-job-state-fixture-sync: missing ${BACKEND_DIR}" >&2
  exit 2
fi
if [[ ! -d "${IOS_DIR}" ]]; then
  echo "check-job-state-fixture-sync: missing iOS copy directory ${IOS_DIR}" >&2
  exit 2
fi

# The FIXED set both suites depend on (Codex EP cycle 1, iOS finding 1): a
# missing member fails closed even before byte comparison — an incomplete
# directory that "happens to match" must never pass.
REQUIRED_FILES=(
  input-job.json
  single-board-boards-null.json
  single-board-boards-empty.json
  web-build-job-state-for-wire.json
  ios-build-job-state-for-server.json
  manifest.json
)
fail=0
for name in "${REQUIRED_FILES[@]}"; do
  if [[ ! -f "${BACKEND_DIR}/${name}" ]]; then
    echo "MISSING  ${name}: required fixture absent from the backend set" >&2
    fail=1
  fi
done
if [[ "${fail}" -ne 0 ]]; then
  echo "check-job-state-fixture-sync: FAILED — the backend fixture set is incomplete." >&2
  exit 1
fi

count=0
shopt -s nullglob
for src in "${BACKEND_DIR}"/*; do
  name="$(basename "${src}")"
  dst="${IOS_DIR}/${name}"
  count=$((count + 1))
  if [[ ! -f "${dst}" ]]; then
    echo "MISSING  ${name}: no iOS copy at ${dst}" >&2
    fail=1
    continue
  fi
  if ! cmp -s "${src}" "${dst}"; then
    echo "DRIFT    ${name}: backend and iOS copies differ" >&2
    echo "         backend: $(shasum -a 256 "${src}" | cut -d' ' -f1)" >&2
    echo "         ios:     $(shasum -a 256 "${dst}" | cut -d' ' -f1)" >&2
    fail=1
  fi
done
for dst in "${IOS_DIR}"/*; do
  name="$(basename "${dst}")"
  if [[ ! -f "${BACKEND_DIR}/${name}" ]]; then
    echo "EXTRA    ${name}: present on iOS but absent from the backend fixture set" >&2
    fail=1
  fi
done

if [[ "${count}" -eq 0 ]]; then
  echo "check-job-state-fixture-sync: no fixtures found in ${BACKEND_DIR}" >&2
  exit 2
fi
if [[ "${fail}" -ne 0 ]]; then
  echo "check-job-state-fixture-sync: FAILED — copy the backend fixtures to the iOS repo (same bytes) and commit both." >&2
  exit 1
fi
echo "check-job-state-fixture-sync: OK (${count} files byte-identical; iOS root ${ios_root})"
