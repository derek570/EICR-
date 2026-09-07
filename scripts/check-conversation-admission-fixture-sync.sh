#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
canonical="$repo_root/config/conversation-admission-vectors.json"
ios_copy="${IOS_REPO_ROOT:-$repo_root/CertMateUnified}/Tests/CertMateUnifiedTests/Fixtures/conversation-admission-vectors.json"

if [[ ! -f "$ios_copy" ]]; then
  echo "ConversationAdmissionV1 iOS fixture copy not found: $ios_copy" >&2
  exit 1
fi

cmp --silent "$canonical" "$ios_copy" || {
  echo "ConversationAdmissionV1 fixtures differ: $canonical != $ios_copy" >&2
  exit 1
}

echo "ConversationAdmissionV1 fixture copies are byte-identical."
